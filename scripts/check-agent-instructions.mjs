#!/usr/bin/env node
// Inspect native model requests with fixture instructions and a loopback provider.
// Never use account credentials, user projects, or a paid model for this check.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { AgentRpc } from '../server/rpc.mjs'
import { DEFAULT_MODEL, rcpModelCatalog } from '../server/model-catalog.mjs'

const markers = {
  root: 'ROOT_AGENTS_INSTRUCTION_FIXTURE_MARKER',
  nested: 'NESTED_AGENTS_INSTRUCTION_FIXTURE_MARKER',
  sibling: 'SIBLING_AGENTS_INSTRUCTION_FIXTURE_MARKER',
  outside: 'OUTSIDE_PROJECT_INSTRUCTION_FIXTURE_MARKER',
}
const nativeHome = path.resolve(
  process.env.STUDIO_TEST_LEMEX_HOME || '.runtime/lemex',
)
const executable = path.join(nativeHome, 'bin/lemex')
const output = path.resolve('.runtime/agents-instructions-check')
const captures = []
const startedAt = new Date().toISOString()
let directory, home, workspace, instructions, child, rpc, stopped
let stage = 'prepare-fixture'
let report = {
  passed: false,
  status: 'running',
  startedAt,
  native: { path: executable },
  providerCalls: 0,
  fixtureCleanupComplete: false,
}

async function saveReport() {
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}

function errorSummary(error) {
  return {
    name: error?.name || 'Error',
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    message: String(error?.message || 'Native instruction check failed.')
      .split('\n')[0]
      .slice(0, 400),
  }
}

// Clear any earlier pass before native startup, file reads, or probe assertions.
await fs.mkdir(output, { recursive: true })
await saveReport()

function markerPositions(request, marker) {
  const positions = []
  for (const [messageIndex, item] of (request.input || []).entries()) {
    for (const [contentIndex, content] of (item.content || []).entries()) {
      if (typeof content.text !== 'string') continue
      const markerOffset = content.text.indexOf(marker)
      if (markerOffset >= 0)
        positions.push({
          messageIndex,
          contentIndex,
          role: item.role,
          markerOffset,
        })
    }
  }
  return positions
}

const server = createServer(async (req, res) => {
  if (
    req.method === 'GET' &&
    ['/v1/models', '/v1/model/info'].includes(req.url)
  ) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: DEFAULT_MODEL, object: 'model' }] }))
    return
  }
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.writeHead(404).end()
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  captures.push(JSON.parse(raw))
  const item = {
    type: 'message',
    id: `fixture-answer-${captures.length}`,
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Offline fixture completed.' }],
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  })
  for (const [type, value] of [
    ['response.created', { response: { id: `fixture-${captures.length}` } }],
    ['response.output_item.done', { output_index: 0, item }],
    [
      'response.completed',
      {
        response: {
          id: `fixture-${captures.length}`,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      },
    ],
  ])
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
  res.end()
})

async function probe(name, cwd) {
  let timer, listener
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Native AGENTS fixture timed out.')),
      20000,
    )
    listener = ({ method, params }) => {
      if (method === 'turn/completed') resolve(params.turn)
    }
    rpc.on('notification', listener)
  })
  completed.catch(() => {})
  try {
    const cursor = captures.length
    const thread = await rpc.call(
      'thread/start',
      {
        model: DEFAULT_MODEL,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        developerInstructions: instructions,
        ephemeral: false,
      },
      10000,
    )
    await rpc.call(
      'turn/start',
      {
        threadId: thread.thread.id,
        effort: 'low',
        input: [
          {
            type: 'text',
            text: 'Finish this offline fixture without changing files.',
            textElements: [],
          },
        ],
      },
      10000,
    )
    assert.equal((await completed).status, 'completed')
    const requests = captures.slice(cursor)
    assert.equal(requests.length, 1)
    const request = requests[0]
    const positions = Object.fromEntries(
      Object.entries(markers).map(([key, marker]) => [
        key,
        markerPositions(request, marker),
      ]),
    )
    const developerPromptPositions = markerPositions(
      request,
      instructions.trim(),
    )
    const developerPromptIncluded = developerPromptPositions.some(
      (position) => position.role === 'developer',
    )
    assert(
      developerPromptIncluded,
      'The current full Lemex prompt reaches the developer message.',
    )
    for (const key of ['outside', 'sibling'])
      assert.equal(positions[key].length, 0)
    for (const key of ['root', 'nested'])
      assert(
        positions[key].every((position) => position.role === 'user'),
        'Project instructions must not be promoted into app developer instructions.',
      )
    return {
      name,
      threadStart: {
        cwd:
          cwd === workspace ? '<fixture-project>' : '<fixture-project>/Nested',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        developerInstructionsPresent: true,
        ephemeral: false,
      },
      requests: requests.length,
      markers: positions,
      developerPromptIncluded,
      developerPromptPositions,
    }
  } finally {
    clearTimeout(timer)
    rpc.off('notification', listener)
  }
}

try {
  instructions = await fs.readFile(
    new URL('../prompts/lean-assistant.md', import.meta.url),
    'utf8',
  )
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-agent-instructions-'),
  )
  home = path.join(directory, 'home')
  workspace = path.join(directory, 'workspace')
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace)])
  await Promise.all(
    ['Nested', 'Sibling'].map((folder) =>
      fs.mkdir(path.join(workspace, folder)),
    ),
  )
  await Promise.all([
    fs.writeFile(path.join(directory, 'AGENTS.md'), markers.outside + '\n'),
    fs.writeFile(path.join(workspace, 'AGENTS.md'), markers.root + '\n'),
    fs.writeFile(
      path.join(workspace, 'Nested/AGENTS.md'),
      markers.nested + '\n',
    ),
    fs.writeFile(
      path.join(workspace, 'Sibling/AGENTS.md'),
      markers.sibling + '\n',
    ),
  ])
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/v1`
  const catalog = JSON.parse(
    await fs.readFile(
      new URL('../server/lemex-models.json', import.meta.url),
      'utf8',
    ),
  )
  const profile = catalog.models.find((model) => model.slug === DEFAULT_MODEL)
  assert(profile, 'The fixture uses an installed model profile.')
  await fs.writeFile(
    path.join(home, 'models.json'),
    JSON.stringify(rcpModelCatalog({ models: [profile] })),
  )
  await fs.writeFile(
    path.join(home, 'config.toml'),
    [
      'model_provider = "rcp"',
      `model = ${JSON.stringify(DEFAULT_MODEL)}`,
      'model_catalog_json = "models.json"',
      'web_search = "disabled"',
      'features.daemon_auto_start = false',
      '[model_providers.rcp]',
      'name = "RCP"',
      `base_url = ${JSON.stringify(base)}`,
      'env_key = "LEMEX_API_KEY"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'supports_websockets = false',
      'supports_standalone_web_search = false',
      '[analytics]',
      'enabled = false',
      '[feedback]',
      'enabled = false',
    ].join('\n') + '\n',
    { mode: 0o600 },
  )
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    LEMEX_HOME: home,
    LEMEX_API_KEY: 'fixture-only',
    LEMEX_BASE_URL: base,
  }
  stage = 'native-identity'
  const version = (
    await promisify(execFile)(executable, ['--version'], {
      env: environment,
      timeout: 10000,
    })
  ).stdout.trim()
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(executable)) hash.update(chunk)
  const digest = hash.digest('hex')
  report.native = { path: executable, version, sha256: digest }
  stage = 'manifest-verification'
  const installation = JSON.parse(
    await fs.readFile(path.join(nativeHome, 'lemex-install.json'), 'utf8'),
  )
  assert.equal(
    digest,
    installation.native_artifact_sha256.lemex,
    'The native binary matches its installed artifact manifest.',
  )
  let releaseMatch = null
  if (process.env.STUDIO_TEST_RELEASE_MANIFEST) {
    const release = JSON.parse(
      await fs.readFile(process.env.STUDIO_TEST_RELEASE_MANIFEST, 'utf8'),
    )
    assert.equal(
      digest,
      release.lemex.native_artifact_sha256.lemex,
      'The native binary matches the worker runtime recorded for this release.',
    )
    assert(version.includes(release.lemex.version))
    releaseMatch = true
  }
  stage = 'native-startup'
  child = spawn(executable, ['app-server', '--stdio', '--strict-config'], {
    cwd: workspace,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  stopped = new Promise((resolve) => {
    child.once('close', resolve)
    child.once('error', resolve)
  })
  child.stderr.resume()
  rpc = new AgentRpc(child)
  rpc.on('request', (request) =>
    rpc.respond(request.id, { decision: 'decline' }),
  )
  await rpc.call(
    'initialize',
    {
      clientInfo: {
        name: 'leanflow_agent_instructions_fixture',
        version: '0.1.0',
      },
    },
    10000,
  )
  rpc.notify('initialized')
  stage = 'root-instructions'
  const root = await probe('root-no-git-explicit-developer', workspace)
  assert.equal(
    root.markers.root.length,
    1,
    'Root AGENTS.md reaches the model without Git metadata.',
  )
  assert.equal(
    root.markers.nested.length,
    0,
    'Nested instructions do not become global project guidance.',
  )
  stage = 'nested-instructions'
  const nested = await probe(
    'nested-no-git-explicit-developer',
    path.join(workspace, 'Nested'),
  )
  assert.equal(nested.markers.nested.length, 1)
  assert.equal(
    nested.markers.root.length,
    0,
    'Without a Git root, native discovery starts at the given cwd.',
  )
  assert.match(
    instructions,
    /Before working on or editing files in a subdirectory/,
  )
  assert.match(
    instructions,
    /deeper instructions\s+override ancestor instructions only within their own directory and descendants/,
  )
  report = {
    passed: true,
    status: 'passed',
    startedAt,
    checkedAt: new Date().toISOString(),
    native: {
      path: executable,
      version,
      sha256: digest,
      installedManifestMatches: true,
      releaseManifestMatches: releaseMatch,
    },
    promptSha256: createHash('sha256').update(instructions).digest('hex'),
    gitRepositoryPresent: false,
    cases: [root, nested],
    nestedGuidancePresent: true,
    modelRequestConfirmed: true,
    providerCalls: 0,
    loopbackFixtureRequests: captures.length,
    personalHomeOrCredentialsCopied: false,
    evidenceScope: {
      developerInstructions: 'Complete current prompts/lean-assistant.md',
      providerConfiguration: 'Isolated loopback provider and fixture catalog',
      productionRuntimeAddendaIncluded: false,
    },
    limitation:
      'Model request capture proves inclusion and instruction roles; a mock provider does not establish model compliance.',
  }
} catch (error) {
  report = {
    ...report,
    passed: false,
    status: 'failed',
    failureStage: stage,
    error: errorSummary(error),
  }
  throw error
} finally {
  const cleanupErrors = []
  for (const cleanup of [
    () => rpc?.close(),
    async () => {
      if (!child) return
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 1500)
      try {
        await stopped
      } finally {
        clearTimeout(force)
      }
    },
    async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
    () => directory && fs.rm(directory, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(errorSummary(error))
    }
  }
  report = {
    ...report,
    ...(cleanupErrors.length
      ? { passed: false, status: 'failed', cleanupErrors }
      : {}),
    completedAt: new Date().toISOString(),
    loopbackFixtureRequests: captures.length,
    fixtureCleanupComplete: cleanupErrors.length === 0,
  }
  await saveReport()
}
assert(
  report.passed,
  'Native instruction check cleanup failed; inspect report.json.',
)
console.log(JSON.stringify(report, null, 2))
