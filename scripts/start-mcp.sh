#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

ensure_supported_os
ensure_node
ensure_pnpm
load_env_file

cd "$ROOT_DIR"
exec pnpm --filter @leadfactory/mcp-server dev
