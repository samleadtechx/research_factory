#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$ROOT_DIR/.leadfactory"
RUN_DIR="$STATE_DIR/run"
LOG_DIR="$STATE_DIR/logs"

mkdir -p "$RUN_DIR" "$LOG_DIR"

log() {
  printf '[leadfactory] %s\n' "$*"
}

fail() {
  printf '[leadfactory] ERROR: %s\n' "$*" >&2
  exit 1
}

ensure_supported_os() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) fail "Only macOS and Linux are supported by these scripts." ;;
  esac
}

ensure_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

ensure_docker_daemon() {
  ensure_command docker
  if ! docker info >/dev/null 2>&1; then
    fail "Docker is installed but not reachable. Start Docker Desktop on macOS, or make sure your Linux user can access the Docker daemon."
  fi
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    fail "Docker Compose is required. Install Docker Desktop or docker-compose."
  fi
}

ensure_node() {
  ensure_command node
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])")"
  if [ "$major" -lt 20 ]; then
    fail "Node.js 20+ is required. Found $(node --version)."
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    log "pnpm not found; enabling pnpm through corepack."
    corepack enable
    corepack prepare pnpm@11.19.0 --activate
    return
  fi

  if command -v npm >/dev/null 2>&1; then
    log "pnpm not found; installing pnpm with npm."
    npm install -g pnpm@11.19.0
    return
  fi

  fail "pnpm is required and could not be installed automatically."
}

ensure_python() {
  if command -v python3 >/dev/null 2>&1; then
    return
  fi

  if command -v python >/dev/null 2>&1; then
    return
  fi

  fail "Python 3 is required for Camoufox and Scrapy."
}

python_command() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "python3"
  else
    printf '%s\n' "python"
  fi
}

venv_python() {
  printf '%s\n' "$ROOT_DIR/.venv/bin/python"
}

install_browser_runtime() {
  ensure_python

  local py
  py="$(python_command)"

  if [ ! -x "$(venv_python)" ]; then
    log "Creating Python virtual environment at .venv."
    (cd "$ROOT_DIR" && "$py" -m venv .venv)
  fi

  log "Installing Python browser/research packages: Camoufox and Scrapy."
  "$(venv_python)" -m pip install --upgrade pip setuptools wheel
  "$(venv_python)" -m pip install -r "$ROOT_DIR/requirements-browser.txt"

  if [ "${SKIP_BROWSER_DOWNLOADS:-0}" != "1" ]; then
    log "Installing Playwright Chromium browser."
    (cd "$ROOT_DIR" && pnpm --filter @leadfactory/worker-browser exec playwright install chromium)

    log "Fetching Camoufox browser binaries."
    if ! "$(venv_python)" -m camoufox fetch; then
      log "Camoufox package installed, but browser binary fetch failed. Run '.venv/bin/python -m camoufox fetch' later."
    fi
  else
    log "SKIP_BROWSER_DOWNLOADS=1, skipping Playwright/Camoufox browser downloads."
  fi
}

ensure_env_file() {
  if [ ! -f "$ROOT_DIR/.env" ]; then
    cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
    log "Created .env from .env.example. Edit it if your ports or LLM model change."
  fi
}

load_env_file() {
  ensure_env_file
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
}

url_host() {
  node -e "const u = new URL(process.argv[1]); process.stdout.write(u.hostname || 'localhost')" "$1"
}

url_port() {
  node -e "const u = new URL(process.argv[1]); process.stdout.write(u.port || process.argv[2])" "$1" "$2"
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local name="$3"
  local timeout_seconds="${4:-60}"
  local start
  start="$(date +%s)"

  while true; do
    if node -e "
      const net = require('node:net');
      const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); process.exit(0); });
      socket.once('timeout', () => { socket.destroy(); process.exit(1); });
      socket.once('error', () => process.exit(1));
    " "$host" "$port" >/dev/null 2>&1; then
      log "$name is reachable at $host:$port."
      return
    fi

    if [ $(( $(date +%s) - start )) -ge "$timeout_seconds" ]; then
      fail "Timed out waiting for $name at $host:$port."
    fi

    sleep 1
  done
}

start_infra() {
  ensure_docker_daemon
  log "Starting Postgres and Redis."
  (cd "$ROOT_DIR" && compose up -d postgres redis)

  local db_url="${DATABASE_URL:-postgresql://leadfactory:leadfactory@localhost:5432/leadfactory}"
  local redis_url="${REDIS_URL:-redis://localhost:6379}"

  wait_for_tcp "$(url_host "$db_url")" "$(url_port "$db_url" 5432)" "Postgres" 90
  wait_for_tcp "$(url_host "$redis_url")" "$(url_port "$redis_url" 6379)" "Redis" 60
}

pid_file_for() {
  printf '%s/%s.pid' "$RUN_DIR" "$1"
}

is_running() {
  local pid_file
  pid_file="$(pid_file_for "$1")"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1
}

start_process() {
  local name="$1"
  shift
  local pid_file
  pid_file="$(pid_file_for "$name")"

  if is_running "$name"; then
    log "$name already running with PID $(cat "$pid_file")."
    return
  fi

  if [ -f "$pid_file" ]; then
    rm "$pid_file"
  fi

  log "Starting $name."
  (
    cd "$ROOT_DIR"
    nohup "$@" > "$LOG_DIR/$name.log" 2>&1 &
    echo $! > "$pid_file"
  )

  sleep 1
  if ! is_running "$name"; then
    log "$name did not stay running. Last log lines:"
    tail -n 40 "$LOG_DIR/$name.log" || true
    fail "$name failed to start."
  fi

  log "$name started with PID $(cat "$pid_file"). Logs: $LOG_DIR/$name.log"
}

stop_process() {
  local name="$1"
  local pid_file
  pid_file="$(pid_file_for "$name")"

  if ! is_running "$name"; then
    [ -f "$pid_file" ] && rm "$pid_file"
    log "$name is not running."
    return
  fi

  local pid
  pid="$(cat "$pid_file")"
  log "Stopping $name with PID $pid."
  kill "$pid" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm "$pid_file"
      log "$name stopped."
      return
    fi
    sleep 0.5
  done

  log "$name did not exit after 10 seconds; forcing stop."
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm "$pid_file"
}

show_process_status() {
  local name="$1"
  if is_running "$name"; then
    printf '%-18s running   pid=%s   log=%s\n' "$name" "$(cat "$(pid_file_for "$name")")" "$LOG_DIR/$name.log"
  else
    printf '%-18s stopped\n' "$name"
  fi
}

app_services() {
  printf '%s\n' api dashboard worker-browser worker-analysis
}
