#!/usr/bin/env node
// Exercise the installed native image tool against a loopback-only fake model.
// No account credentials, provider traffic, or user projects are used.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { deflateSync, crc32 } from 'node:zlib'
import { AgentRpc } from '../server/rpc.mjs'
import { DEFAULT_MODEL, rcpModelCatalog } from '../server/model-catalog.mjs'
import { providerRequestConfig } from '../server/provider-requests.mjs'
import { RCP_BASE_URL } from '../server/provider-endpoint.mjs'

function fixturePng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
    return Buffer.concat([length, name, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk(
      'IDAT',
      deflateSync(
        Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]),
      ),
    ),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function hasImage(input) {
  return input.some((item) =>
    [
      ...(Array.isArray(item.content) ? item.content : []),
      ...(Array.isArray(item.output) ? item.output : []),
    ].some(
      (part) =>
        part.type === 'input_image' &&
        /^data:image\/png;base64,/.test(part.image_url),
    ),
  )
}

async function probe({ legacy = false, attached = false } = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-native-vision-'),
  )
  const home = path.join(directory, 'home')
  const workspace = path.join(directory, 'workspace')
  const temporaryImage = path.join(directory, 'temporary-page.png')
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace)])
  const requests = []
  let child, rpc, stopped, timer
  const server = createServer(async (req, res) => {
    if (
      req.method === 'GET' &&
      ['/v1/models', '/v1/model/info'].includes(req.url)
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({ data: [{ id: DEFAULT_MODEL, object: 'model' }] }),
      )
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push(JSON.parse(raw))
    const callImage = !attached && requests.length === 1
    const item = callImage
      ? {
          type: 'function_call',
          id: 'fixture-call',
          call_id: 'fixture-image',
          name: 'view_image',
          arguments: JSON.stringify({ path: temporaryImage }),
        }
      : {
          type: 'message',
          id: 'fixture-answer',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Fixture completed.' }],
        }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    })
    for (const [type, value] of [
      ['response.created', { response: { id: `fixture-${requests.length}` } }],
      ['response.output_item.done', { output_index: 0, item }],
      [
        'response.completed',
        {
          response: {
            id: `fixture-${requests.length}`,
            status: 'completed',
            output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          },
        },
      ],
    ])
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
      )
    res.end()
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const profile = JSON.parse(
      await fs.readFile(
        new URL('../server/lemex-models.json', import.meta.url),
        'utf8',
      ),
    ).models.find((model) => model.slug === DEFAULT_MODEL)
    const original = { models: [{ ...profile, input_modalities: ['text'] }] }
    await fs.writeFile(
      path.join(home, 'models.json'),
      JSON.stringify(legacy ? original : rcpModelCatalog(original)),
    )
    await fs.writeFile(temporaryImage, fixturePng())
    await fs.writeFile(
      path.join(home, 'config.toml'),
      [
        'model_provider = "rcp"',
        `model = ${JSON.stringify(DEFAULT_MODEL)}`,
        'model_catalog_json = "models.json"',
        'web_search = "disabled"',
        'features.daemon_auto_start = false',
        ...providerRequestConfig({
          LEMEX_API_KEY: 'fixture-only',
          LEMEX_BASE_URL: RCP_BASE_URL,
        }),
        '[model_providers.rcp]',
        'name = "RCP"',
        `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
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
    )
    const executable = path.resolve(
      process.env.STUDIO_TEST_LEMEX_HOME || '.runtime/lemex',
      'bin/lemex',
    )
    child = spawn(executable, ['app-server', '--stdio', '--strict-config'], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LEMEX_HOME: home,
        LEMEX_API_KEY: 'fixture-only',
        LEMEX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      },
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
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Native image fixture timed out.')),
        25000,
      )
      rpc.on('notification', ({ method, params }) => {
        if (method === 'turn/completed') resolve(params)
      })
    })
    completed.catch(() => {})
    await rpc.call(
      'initialize',
      { clientInfo: { name: 'leanflow_vision_fixture', version: '0.1.0' } },
      10000,
    )
    rpc.notify('initialized')
    const thread = await rpc.call(
      'thread/start',
      {
        model: DEFAULT_MODEL,
        cwd: workspace,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: true,
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
            text: 'Inspect the fixture image if provided, then finish.',
            textElements: [],
          },
          ...(attached ? [{ type: 'localImage', path: temporaryImage }] : []),
        ],
      },
      10000,
    )
    await completed
    assert(requests.length > 0)
    assert(requests[0].tools.some((tool) => tool.name === 'view_image'))
    assert.equal(requests[0].model, DEFAULT_MODEL)
    if (attached)
      assert(
        hasImage(requests[0].input),
        'Explicit image content reaches the model request.',
      )
    else {
      assert.equal(requests.length, 2)
      const output = requests[1].input.filter(
        (item) => item.type === 'function_call_output',
      )
      if (legacy) {
        assert.equal(hasImage(output), false)
        assert(
          output.some(
            (item) =>
              typeof item.output === 'string' &&
              /not allowed.*image inputs/.test(item.output),
          ),
          'The legacy profile reproduces the model capability failure.',
        )
      } else {
        assert(
          hasImage(output),
          'The native image tool returns actual image content, including files outside cwd in the isolated temporary area.',
        )
      }
    }
    return {
      legacy,
      attached,
      requests: requests.length,
      imageToolAllowed: !legacy,
      imageContent: !legacy,
      providerId: 'rcp',
      wireApi: 'responses',
    }
  } finally {
    clearTimeout(timer)
    rpc?.close()
    if (child) {
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 1500)
      await stopped
      clearTimeout(force)
    }
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const report = {
  passed: true,
  model: DEFAULT_MODEL,
  checks: [
    await probe({ legacy: true }),
    await probe(),
    await probe({ attached: true }),
  ],
  providerCalls: 0,
}
const output = path.resolve('.runtime/vision-harness-review')
await fs.mkdir(output, { recursive: true })
await fs.writeFile(
  path.join(output, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
)
console.log(JSON.stringify(report))
