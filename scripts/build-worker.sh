#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
runtime_bundle_dir="${LEMEX_RUNTIME_DIR:-.runtime/lemex}"
python3 scripts/package-lemex.py --destination "$runtime_bundle_dir" "$@"
docker build --file deploy/Dockerfile.worker --build-arg "LEMEX_RUNTIME_DIR=$runtime_bundle_dir" --tag "${LEMEX_WORKER_IMAGE:-lemex-web-worker:local}" .
