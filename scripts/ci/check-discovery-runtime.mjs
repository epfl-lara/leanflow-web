import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// Run before switching to a staged release. Exercise its native discovery
// code with a local catalog, without reading any account files or keys.
const release = path.resolve(process.argv[2] || '.')
const packaged = path.join(release, '.runtime/lemex')
const readJson = async (filename) =>
  JSON.parse(await fs.readFile(filename, 'utf8'))
const expected = (await readJson(path.join(release, 'release-manifest.json')))
  .lemex
assert.match(
  expected?.native_artifact_sha256?.lemex || '',
  /^[a-f0-9]{64}$/,
  'The release manifest must pin the Lemex executable.',
)

async function verifyRuntime(home) {
  const installed = await readJson(path.join(home, 'lemex-install.json'))
  assert.deepEqual(
    installed,
    expected,
    'Lemex provenance differs from the release manifest.',
  )
  await fs.access(path.join(home, 'config.toml'))
  const catalog = await readJson(path.join(home, 'models.json'))
  assert(
    Array.isArray(catalog.models) && catalog.models.length,
    'The packaged Lemex catalog is empty.',
  )
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path.join(home, 'bin/lemex')))
    digest.update(chunk)
  assert.equal(
    digest.digest('hex'),
    expected.native_artifact_sha256.lemex,
    'Lemex executable differs from the release manifest.',
  )
}

await verifyRuntime(packaged)
const { loadConfig } = await import(
  pathToFileURL(path.join(release, 'server/config.mjs'))
)
const { discoverNativeModels } = await import(
  pathToFileURL(path.join(release, 'server/model-discovery.mjs'))
)
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'leanflow-release-discovery-'),
)
try {
  const config = await loadConfig(directory, {
    env: { LEMEX_HOME: process.env.LEMEX_HOME },
  })
  if ((await fs.realpath(config.lemexHome)) !== (await fs.realpath(packaged))) {
    assert(
      process.env.LEMEX_HOME,
      'Model discovery did not select the staged runtime.',
    )
    await verifyRuntime(config.lemexHome)
  }
  const { stdout } = await promisify(execFile)(
    path.join(config.lemexHome, 'bin/lemex'),
    ['--version'],
    {
      env: { HOME: directory, LEMEX_HOME: directory, PATH: process.env.PATH },
      timeout: 10000,
    },
  )
  assert(
    stdout.trim().split(/\s+/).includes(expected.version),
    'Lemex reported a different version from the release manifest.',
  )
  const catalog = await discoverNativeModels({
    config,
    provider: {
      LEMEX_API_KEY: 'fixture-release-key',
      LEMEX_BASE_URL: 'https://provider.example/v1',
    },
    directory,
    signal: AbortSignal.timeout(35000),
    fetchImpl: async () =>
      Response.json({
        data: [
          { id: 'fixture/release-model', object: 'model', owned_by: 'fixture' },
        ],
      }),
  })
  assert(
    catalog.models.some((model) => model.slug === 'fixture/release-model'),
    'The staged Lemex runtime could not discover the offline fixture model.',
  )
  console.log(
    `Verified Lemex ${expected.version} and native model discovery in the staged release.`,
  )
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
