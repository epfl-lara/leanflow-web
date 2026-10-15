#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker build --file deploy/Dockerfile.tex --tag "${STUDIO_TEX_IMAGE:-leanflow-tex:local}" .
