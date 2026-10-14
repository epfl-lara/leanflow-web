import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  repairProjectSetup,
  withSetupRepairDeadline,
} from '../setup-repair.mjs'
import { rcpModelCatalog, DEFAULT_MODEL } from '../model-catalog.mjs'
import { catalogModels } from '../config.mjs'

test('repair writes the normalized model catalog and sends the exact configured default effort', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-repair-config-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  await fs.mkdir(path.join(home, '.lemex'), { recursive: true })
  const modelCatalog = rcpModelCatalog({
    models: [
      {
        slug: DEFAULT_MODEL,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'medium' }],
      },
    ],
  })
  const config = {
    provider: { LEMEX_API_KEY: 'fixture-unused' },
    defaultModel: DEFAULT_MODEL,
    modelCatalog,
    models: catalogModels(modelCatalog, DEFAULT_MODEL),
    redact: String,
  }
  const requests = []
  const child = new EventEmitter()
  for (const stream of ['stdin', 'stdout', 'stderr'])
    child[stream] = new PassThrough()
  child.kill = () =>
    queueMicrotask(() => {
      child.stdout.end()
      child.emit('close', 0)
    })
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line)
      requests.push(request)
      if (!('id' in request)) continue
      const result =
        request.method === 'thread/start'
          ? { thread: { id: 'repair-thread' } }
          : {}
      child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
      if (request.method === 'turn/start')
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
            }) + '\n',
          ),
        )
    }
  })
  await repairProjectSetup({
    root,
    project: { name: 'Fixture' },
    error: 'Invalid Lake config',
    runtime: { home: async () => home, spawnWhenAvailable: async () => child },
    config,
  })
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(home, '.lemex/models.json'), 'utf8'),
    ),
    modelCatalog,
  )
  assert.match(
    await fs.readFile(path.join(home, '.lemex/config.toml'), 'utf8'),
    /model_catalog_json = "models.json"/,
  )
  assert.equal(
    requests.find((r) => r.method === 'thread/start').params.model,
    DEFAULT_MODEL,
  )
  assert.equal(
    requests.find((r) => r.method === 'turn/start').params.effort,
    'max',
  )
})

test('the automatic repair deadline cancels queued or running work and reports a retryable timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const repair = withSetupRepairDeadline(
    (bounded) => {
      signal = bounded
      return new Promise((_, reject) =>
        bounded.addEventListener('abort', () => reject(bounded.reason), {
          once: true,
        }),
      )
    },
    { timeoutMs: 1000 },
  )
  t.mock.timers.tick(1000)
  await assert.rejects(
    repair,
    /setup repair reached its time limit.*source files are preserved/,
  )
  assert.equal(signal.aborted, true)
})

test('a stopped setup cannot enter the specialized repair agent', async () => {
  const controller = new AbortController()
  controller.abort(new Error('Stopped fixture'))
  await assert.rejects(
    withSetupRepairDeadline(
      () => assert.fail('Repair invoked after cancellation'),
      { signal: controller.signal },
    ),
    /Stopped fixture/,
  )
})
