#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

ensure_supported_os
ensure_node
ensure_pnpm
ensure_docker_daemon
ensure_env_file
load_env_file

log "Installing workspace dependencies."
(cd "$ROOT_DIR" && pnpm install)

install_browser_runtime

start_infra

log "Generating Prisma client."
(cd "$ROOT_DIR" && pnpm db:generate)

if [ "${SKIP_DB_PUSH:-0}" != "1" ]; then
  log "Applying Prisma schema to the local database."
  (cd "$ROOT_DIR" && pnpm db:push)
fi

log "Running typecheck and tests."
(cd "$ROOT_DIR" && pnpm typecheck && pnpm test)

log "Install complete."
log "Start the app with: scripts/start.sh"
