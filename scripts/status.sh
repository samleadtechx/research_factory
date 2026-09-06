#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

for service in $(app_services); do
  show_process_status "$service"
done

printf '\nState: %s\nLogs:  %s\n' "$STATE_DIR" "$LOG_DIR"
