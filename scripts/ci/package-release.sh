#!/usr/bin/env bash
# Package committed source and the exact client/worker that passed release checks.
set -euo pipefail
cd "$(dirname "$0")/../.."
git diff --exit-code HEAD --
test -s client/dist/index.html
release_commit="$(git rev-parse HEAD)"
release_dir=.runtime/release
test ! -e "$release_dir"
mkdir -p "$release_dir"
stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT
git archive --format=tar --prefix=leanflow-web/ HEAD | tar -xf - -C "$stage_dir"
# Never admit deployment state, even if accidentally tracked in a future commit.
python3 - "$stage_dir/leanflow-web" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
for item in root.rglob('*'):
    name = item.name
    if item.is_symlink():
        raise SystemExit(f'Symlinks are not release assets: {item.relative_to(root)}')
    if (name in {'.data', '.runtime', '.git', '.ssh', '.codex', '.claude', 'auth.json', 'credentials.json', 'id_rsa', 'id_ed25519'}
            or (name.startswith('.env') and name != '.env.example')
            or name.endswith(('.pem', '.key', '.p12', '.pfx'))):
        raise SystemExit(f'Private state is not a release asset: {item.relative_to(root)}')
for item in Path('client/dist').rglob('*'):
    if item.is_symlink():
        raise SystemExit(f'Symlinks are not client assets: {item}')
PY
cp -R client/dist "$stage_dir/leanflow-web/client/dist"
worker_image="${LEMEX_WORKER_IMAGE:?Set the verified worker image}"
worker_id="$(docker image inspect --format '{{.Id}}' "$worker_image")"
node --input-type=module - "$release_commit" "$worker_image" "$worker_id" <<'JS' > "$release_dir/manifest.json"
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const [commit, workerImage, workerImageId] = process.argv.slice(2)
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const lemex = JSON.parse(execFileSync('docker', ['run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', workerImageId, 'cat', '/opt/lemex/lemex-install.json'], { encoding: 'utf8' }))
console.log(JSON.stringify({ version, commit, node: process.version, platform: 'linux/amd64', workerImage, workerImageId, lemex }, null, 2))
JS
cp "$release_dir/manifest.json" "$stage_dir/leanflow-web/release-manifest.json"
tar -czf "$release_dir/leanflow-web-${release_commit}.tar.gz" -C "$stage_dir" leanflow-web
docker image save "$worker_image" | gzip -n > "$release_dir/leanflow-worker-${release_commit}.tar.gz"
cp package-lock.json "$release_dir/package-lock.json"
(cd "$release_dir" && sha256sum ./*.tar.gz manifest.json package-lock.json > SHA256SUMS)
