#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
release_commit="$(git rev-parse HEAD)"
verify_dir="$(mktemp -d)"
trap 'rm -rf "$verify_dir"' EXIT
(cd .runtime/release && sha256sum --check SHA256SUMS)
docker load --input ".runtime/release/leanflow-worker-${release_commit}.tar.gz"
tar -xzf ".runtime/release/leanflow-web-${release_commit}.tar.gz" -C "$verify_dir"
cd "$verify_dir/leanflow-web"
export STUDIO_DATA_DIR="$verify_dir/data"
CYPRESS_INSTALL_BINARY=0 npm ci --omit=dev
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createStudio } from './server/studio.mjs'
const manifest = JSON.parse(await readFile('release-manifest.json', 'utf8'))
assert.equal(process.env.LEMEX_WORKER_IMAGE, manifest.workerImage)
const studio = await createStudio({ dataDir: process.env.STUDIO_DATA_DIR })
try {
  studio.server.listen(0, '127.0.0.1')
  await once(studio.server, 'listening')
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const health = await (await fetch(`${base}/health`)).json()
  assert.equal(health.ok, true)
  assert.equal(health.runtime, true)
  assert.equal(studio.runtime.imageId, manifest.workerImageId)
  assert.equal(studio.runtime.info().lemexVersion, manifest.lemex.version)
  const page = await fetch(base)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html/)
  assert.equal((await fetch(`${base}/api/projects`)).status, 401)
  console.log('Packaged app starts with production dependencies, the verified worker, and authentication enabled.')
} finally {
  await studio.close()
}
JS
