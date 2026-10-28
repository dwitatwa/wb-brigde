#!/usr/bin/env bash
# Start the WorkBuddy Bridge with UI and the WorkBuddy AI failover pool.
# Only the WorkBuddy AI section is served; pass --provider both to add the
# WorkBuddy (CN) section. Accounts join the pool only when their sign-in
# file is uploaded in the UI.
# Usage: ./scripts/start.sh [--wsl]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

EXTRA_ARGS=()
if [[ "$1" == "--wsl" ]]; then
  EXTRA_ARGS+=("--wsl")
  shift
fi

exec node "$PROJECT_DIR/lib/run.js" ui \
  --provider ai \
  "${EXTRA_ARGS[@]}" \
  "$@"
