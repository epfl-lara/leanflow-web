#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8090}"
export STUDIO_DATA_DIR="${STUDIO_DATA_DIR:-$PWD/.data}"
exec node server/studio.mjs
