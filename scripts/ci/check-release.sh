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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { createStudio } from './server/studio.mjs'
import { discoverNativeModels } from './server/model-discovery.mjs'
const manifest = JSON.parse(await readFile('release-manifest.json', 'utf8'))
assert.equal(process.env.LEMEX_WORKER_IMAGE, manifest.workerImage)
const studio = await createStudio({ dataDir: process.env.STUDIO_DATA_DIR })
try {
  assert.equal(path.resolve(studio.config.lemexHome), path.resolve('.runtime/lemex'))
  assert.equal(studio.config.lemex.version, manifest.lemex.version)
  const nativeVersion = execFileSync(path.join(studio.config.lemexHome, 'bin/lemex'), ['--version'], { encoding: 'utf8' })
  assert(nativeVersion.includes(manifest.lemex.version), 'The release must include the native runtime used for account model discovery.')
  const directory = await mkdtemp(path.join(process.env.STUDIO_DATA_DIR, 'model-discovery-smoke-'))
  try {
    const catalog = await discoverNativeModels({
      config: studio.config,
      provider: { LEMEX_API_KEY: 'fixture-release-key', LEMEX_BASE_URL: 'https://provider.example/v1' },
      directory,
      signal: AbortSignal.timeout(35000),
      fetchImpl: async () => Response.json({ data: [{ id: 'fixture/release-model', object: 'model', owned_by: 'fixture' }] }),
    })
    assert(catalog.models.some((model) => model.slug === 'fixture/release-model'), 'Packaged native model discovery must normalize an offline provider catalog.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
  console.log('Packaged app starts with production dependencies, native model discovery, the verified worker, and authentication enabled.')
} finally {
  await studio.close()
}
JS
