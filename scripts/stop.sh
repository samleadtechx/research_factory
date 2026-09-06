#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

for service in $(app_services); do
  stop_process "$service"
done

if [ "${STOP_INFRA:-0}" = "1" ]; then
  ensure_docker_daemon
  log "STOP_INFRA=1, stopping Postgres and Redis."
  (cd "$ROOT_DIR" && compose stop postgres redis)
fi
