#!/usr/bin/env bash
# Start the WorkBuddy Bridge with UI, failover pool, and all discovered accounts.
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
  --pool failover \
  --all-accounts \
  "${EXTRA_ARGS[@]}" \
  "$@"
