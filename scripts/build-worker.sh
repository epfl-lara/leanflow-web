#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
runtime_bundle_dir="${LEMEX_RUNTIME_DIR:-.runtime/lemex}"
worker_arch="$(docker info --format '{{.Architecture}}')"
case "$worker_arch" in
  x86_64|amd64) worker_arch=x64 ;;
  aarch64|arm64) worker_arch=arm64 ;;
  *) echo "Unsupported Linux Docker architecture: $worker_arch" >&2; exit 1 ;;
esac
python3 scripts/package-lemex.py --target-arch "$worker_arch" --destination "$runtime_bundle_dir" "$@"
docker build --file deploy/Dockerfile.worker --build-arg "LEMEX_RUNTIME_DIR=$runtime_bundle_dir" --tag "${LEMEX_WORKER_IMAGE:-lemex-web-worker:local}" .
