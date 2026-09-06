#!/usr/bin/env bash
set -euo pipefail

APP_ROLE="${APP_ROLE:-standalone}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-auto}"
DATABASE_URL="${DATABASE_URL:-}"
REDIS_URL="${REDIS_URL:-}"
PORT="${PORT:-}"
API_PORT="${API_PORT:-4000}"
STANDALONE_PIDS=()

log() {
  printf '[leadfactory:%s] %s\n' "$APP_ROLE" "$*"
}

if [ "$APP_ROLE" = "standalone" ]; then
  export LEADFACTORY_STANDALONE=1
  export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
  if [ -n "$PORT" ] && [ "$API_PORT" = "$PORT" ]; then
    if [ "$PORT" = "4000" ]; then
      API_PORT=4001
    else
      API_PORT=4000
    fi
  fi
  export API_PORT="$API_PORT"
  export DASHBOARD_API_PROXY_TARGET="${DASHBOARD_API_PROXY_TARGET:-http://127.0.0.1:${API_PORT}}"
fi

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
  local timeout_seconds="${4:-120}"
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
      log "Timed out waiting for $name at $host:$port."
      exit 1
    fi

    sleep 1
  done
}

start_standalone_process() {
  log "Starting $1."
  shift
  "$@" &
  STANDALONE_PIDS+=("$!")
}

stop_standalone_processes() {
  if [ "${#STANDALONE_PIDS[@]}" -eq 0 ]; then
    return
  fi

  log "Stopping standalone processes."
  for pid in "${STANDALONE_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait "${STANDALONE_PIDS[@]}" 2>/dev/null || true
}

run_standalone() {
  mkdir -p /app/data/redis

  trap stop_standalone_processes INT TERM EXIT

  start_standalone_process "Redis" redis-server \
    --bind 127.0.0.1 \
    --port 6379 \
    --protected-mode no \
    --appendonly yes \
    --dir /app/data/redis \
    --daemonize no
  wait_for_tcp 127.0.0.1 6379 "Redis"

  start_standalone_process "API" node apps/api/dist/server.js
  wait_for_tcp 127.0.0.1 "$API_PORT" "API"

  start_standalone_process "browser worker" node apps/worker-browser/dist/index.js
  start_standalone_process "analysis worker" node apps/worker-analysis/dist/index.js
  start_standalone_process "dashboard" pnpm --filter @leadfactory/dashboard exec next start --hostname 0.0.0.0 --port "${PORT:-3000}"

  set +e
  wait -n "${STANDALONE_PIDS[@]}"
  exit_code="$?"
  set -e
  log "A standalone process exited with code $exit_code."
  stop_standalone_processes
  trap - INT TERM EXIT
  exit "$exit_code"
}

if [ -n "$DATABASE_URL" ]; then
  wait_for_tcp "$(url_host "$DATABASE_URL")" "$(url_port "$DATABASE_URL" 5432)" "Postgres"
fi

if [ -n "$REDIS_URL" ] && [ "$APP_ROLE" != "dashboard" ] && [ "$APP_ROLE" != "migrate" ] && [ "$APP_ROLE" != "standalone" ]; then
  wait_for_tcp "$(url_host "$REDIS_URL")" "$(url_port "$REDIS_URL" 6379)" "Redis"
fi

should_migrate=0
if [ "$RUN_MIGRATIONS" = "1" ] || [ "$APP_ROLE" = "migrate" ]; then
  should_migrate=1
elif [ "$RUN_MIGRATIONS" = "auto" ] && { [ "$APP_ROLE" = "api" ] || [ "$APP_ROLE" = "standalone" ]; }; then
  should_migrate=1
fi

if [ "$should_migrate" = "1" ]; then
  log "Applying Prisma migrations."
  pnpm db:migrate:deploy
fi

case "$APP_ROLE" in
  standalone)
    run_standalone
    ;;
  api)
    export API_PORT="${PORT:-$API_PORT}"
    exec node apps/api/dist/server.js
    ;;
  dashboard)
    exec pnpm --filter @leadfactory/dashboard exec next start --hostname 0.0.0.0 --port "${PORT:-3000}"
    ;;
  worker-browser)
    exec node apps/worker-browser/dist/index.js
    ;;
  worker-analysis)
    exec node apps/worker-analysis/dist/index.js
    ;;
  mcp)
    exec node apps/mcp-server/dist/index.js
    ;;
  migrate)
    log "Migration role complete."
    exit 0
    ;;
  *)
    log "Unknown APP_ROLE: $APP_ROLE"
    exit 1
    ;;
esac
