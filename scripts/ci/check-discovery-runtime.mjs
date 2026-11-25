import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
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
const execute = promisify(execFile)
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
const { KIMI_K31_PRO, rcpModelCatalog, workerModelConfig, writeModelCatalog } =
  await import(pathToFileURL(path.join(release, 'server/model-catalog.mjs')))
const { RCP_BASE_URL } = await import(
  pathToFileURL(path.join(release, 'server/provider-endpoint.mjs'))
)

async function verifyKimiReasoning(executable, home, catalog) {
  const lemexHome = path.join(home, '.lemex')
  await fs.mkdir(lemexHome, { recursive: true })
  await writeModelCatalog(home, catalog)
  const requests = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: KIMI_K31_PRO, object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const { model, reasoning } = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({
      model,
      effort: reasoning?.effort,
      key: req.headers.authorization,
    })
    const id = `fixture-${requests.length}`
    const item = {
      type: 'message',
      id: `${id}-message`,
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Fixture response.' }],
    }
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: { id, status: 'completed', output: [item] },
      },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
    )
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const key = 'fixture-release-key'
    const settings = workerModelConfig(
      { LEMEX_API_KEY: key, LEMEX_BASE_URL: RCP_BASE_URL },
      catalog,
      KIMI_K31_PRO,
    )
      .join('\n')
      .replace(JSON.stringify(RCP_BASE_URL), JSON.stringify(base))
    await fs.writeFile(
      path.join(lemexHome, 'config.toml'),
      settings +
        '\nfeatures.daemon_auto_start = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n',
    )
    const efforts = ['low', 'high', 'max']
    for (const effort of efforts) {
      const command = execute(
        executable,
        [
          'exec',
          '--strict-config',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '-c',
          `model_reasoning_effort = "${effort}"`,
          'Reply to the offline fixture.',
        ],
        {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            LEMEX_HOME: lemexHome,
            LEMEX_API_KEY: key,
            LEMEX_BASE_URL: base,
          },
          timeout: 20000,
        },
      )
      command.child.stdin.end()
      await command
    }
    assert.deepEqual(
      requests,
      efforts.map((effort) => ({
        model: KIMI_K31_PRO,
        effort,
        key: `Bearer ${key}`,
      })),
    )
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

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
  const executable = path.join(config.lemexHome, 'bin/lemex')
  const { stdout } = await execute(executable, ['--version'], {
    env: { HOME: directory, LEMEX_HOME: directory, PATH: process.env.PATH },
    timeout: 10000,
  })
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
        data: [{ id: KIMI_K31_PRO, object: 'model', owned_by: 'fixture' }],
      }),
  })
  assert(
    catalog.models.some((model) => model.slug === KIMI_K31_PRO),
    'The staged Lemex runtime could not discover the offline fixture model.',
  )
  await verifyKimiReasoning(
    executable,
    path.join(directory, 'worker'),
    rcpModelCatalog(catalog),
  )
  console.log(
    `Verified Lemex ${expected.version}, native model discovery, and Kimi reasoning requests in the staged release.`,
  )
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
