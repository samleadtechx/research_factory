#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

ensure_supported_os
ensure_node
ensure_pnpm
load_env_file
start_infra

log "Generating Prisma client."
(cd "$ROOT_DIR" && pnpm db:generate)

if [ "${AUTO_DB_PUSH_ON_START:-0}" = "1" ]; then
  log "AUTO_DB_PUSH_ON_START=1, applying Prisma schema."
  (cd "$ROOT_DIR" && pnpm db:push)
fi

start_process api pnpm --filter @leadfactory/api dev
start_process dashboard pnpm --filter @leadfactory/dashboard dev
start_process worker-browser pnpm --filter @leadfactory/worker-browser dev
start_process worker-analysis pnpm --filter @leadfactory/worker-analysis dev

log "App started."
log "Dashboard: http://localhost:3000"
log "API: http://localhost:${API_PORT:-4000}"
log "Logs: $LOG_DIR"
log "MCP server is started by Codex over stdio; run scripts/start-mcp.sh manually only for MCP debugging."
