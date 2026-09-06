#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

ensure_supported_os
install_browser_runtime

url="${1:-}"
if [ -n "$url" ]; then
  exec "$(venv_python)" -m camoufox test "$url"
fi

exec "$(venv_python)" -m camoufox test
