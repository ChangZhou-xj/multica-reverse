#!/usr/bin/env bash
# Thin wrapper around the Multica CLI. Configure via environment variables:
#   MULTICA_BIN          path to multica.exe (default: multica on PATH)
#   MULTICA_PROFILE_NAME profile folder under ~/.multica/profiles/
#   MULTICA_WS           workspace UUID
set -euo pipefail
MULTICA_BIN="${MULTICA_BIN:-multica}"
: "${MULTICA_PROFILE_NAME:?set MULTICA_PROFILE_NAME}"
: "${MULTICA_WS:?set MULTICA_WS}"
exec "$MULTICA_BIN" "$@" --profile "$MULTICA_PROFILE_NAME" --workspace-id "$MULTICA_WS"
