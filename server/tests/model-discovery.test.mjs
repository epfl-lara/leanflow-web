import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ModelDiscovery, discoverNativeModels } from '../model-discovery.mjs'
import { Providers } from '../providers.mjs'
import { DEFAULT_MODEL } from '../model-catalog.mjs'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'
import { createChatTitleGenerator } from '../chat-titles.mjs'

const profile = (slug, effort = 'medium', priority = 100) => ({
  slug,
  display_name: slug,
  priority,
  visibility: 'list',
  supported_in_api: true,
  default_reasoning_level: effort,
  supported_reasoning_levels: effort ? [{ effort }] : [],
})
async function fixture(t, discover) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-discovery-'),
  )
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const providers = await new Providers(
    dataDir,
    'fixture-key',
    'https://provider.example/v1',
  ).init()
  const config = {
    defaultModel: DEFAULT_MODEL,
    models: [{ id: 'forbidden-global-model' }],
    provider: { LEMEX_BASE_URL: 'https://provider.example/v1' },
    redact: providers.redact,
  }
  config.providerForUser = (owner) => providers.provider(owner)
  const discovery = new ModelDiscovery({ dataDir, config, providers, discover })
  config.modelsForUser = (owner, options) => discovery.get(owner, options)
  t.after(() => discovery.close())
  return { dataDir, providers, config, discovery }
}

test('fresh catalogs are account scoped, prefer the Lemex default only when available, and invalidate after key changes', async (t) => {
  const calls = []
  const f = await fixture(t, async ({ provider }) => {
    calls.push(provider.LEMEX_API_KEY)
    return {
      models:
        provider.LEMEX_API_KEY === 'alice-fixture-key'
          ? [profile(DEFAULT_MODEL, 'max', 1), profile('Qwen/Qwen3.8-27B')]
          : [profile('limited-model', 'high')],
    }
  })
  assert.deepEqual((await f.discovery.get('missing')).models, [])
  await f.providers.save('alice', 'alice-fixture-key')
  await f.providers.save('bob', 'bob-fixture-key')
  const [alice, bob] = await Promise.all([
    f.discovery.get('alice'),
    f.discovery.get('bob'),
  ])
  assert.equal(alice.defaultModel, DEFAULT_MODEL)
  assert.equal(alice.models[0].defaultReasoningEffort, 'max')
  assert.deepEqual(
    bob.models.map((model) => model.id),
    ['limited-model'],
  )
  assert.equal(bob.defaultModel, 'limited-model')
  assert(!bob.models.some((model) => model.id === DEFAULT_MODEL))
  await f.discovery.get('alice')
  assert.equal(calls.length, 2)
  await f.discovery.get('alice', { refresh: true })
  assert.equal(calls.length, 3)
  await f.providers.save('alice', 'replacement-fixture-key')
  assert.equal((await f.discovery.get('alice')).defaultModel, 'limited-model')
  assert.equal(calls.length, 4)
  assert.equal((await f.discovery.get('bob')).defaultModel, 'limited-model')
})

test('discovery coalesces same-account requests and fails closed after a refresh error or key race', async (t) => {
  let finish,
    fail = false
  const f = await fixture(t, async () => {
    if (fail)
      throw Object.assign(new Error('Provider unavailable'), { status: 503 })
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  await f.providers.save('alice', 'alice-fixture-key')
  const first = f.discovery.get('alice'),
    second = f.discovery.get('alice')
  while (!finish) await new Promise((resolve) => setImmediate(resolve))
  finish({ models: [profile('available')] })
  assert.equal((await first).defaultModel, 'available')
  assert.equal(await first, await second)
  fail = true
  await assert.rejects(
    () => f.discovery.get('alice', { refresh: true }),
    /unavailable/,
  )
  await assert.rejects(() => f.discovery.get('alice'), /unavailable/)
  fail = false
  finish = undefined
  const raced = f.discovery.get('alice')
  while (!finish) await new Promise((resolve) => setImmediate(resolve))
  await f.providers.save('alice', 'alice-replacement-key')
  finish({ models: [profile('previous-key-only')] })
  await assert.rejects(raced, { status: 409 })
})

test('changing endpoints invalidates the catalog even with the same key and cannot complete a stale discovery', async (t) => {
  let calls = 0,
    finish
  const f = await fixture(t, async ({ provider }) => {
    calls++
    if (provider.LEMEX_BASE_URL === 'https://slow.example/v1')
      return new Promise((resolve) => {
        finish = resolve
      })
    return { models: [profile(provider.LEMEX_BASE_URL)] }
  })
  await f.providers.save('alice', 'same-fixture-key')
  const first = await f.discovery.get('alice')
  await f.providers.save(
    'alice',
    'same-fixture-key',
    'https://other.example/v1',
  )
  const second = await f.discovery.get('alice')
  assert.notEqual(first.providerId, second.providerId)
  assert.equal(second.defaultModel, 'https://other.example/v1')
  assert.equal(calls, 2)
  await f.providers.save('alice', 'same-fixture-key', 'https://slow.example/v1')
  const pending = f.discovery.get('alice')
  while (!finish) await new Promise((resolve) => setImmediate(resolve))
  await f.providers.save(
    'alice',
    'same-fixture-key',
    'https://other.example/v1',
  )
  finish({ models: [profile('stale-provider-only')] })
  await assert.rejects(pending, { status: 409 })
})

test('chat naming sends the selected account endpoint its own key and model', async (t) => {
  const f = await fixture(t, async () => ({
    models: [profile('custom/model', null)],
  }))
  await f.providers.save(
    'alice',
    'custom-fixture-key',
    'https://custom.example/v1',
  )
  let sent
  const generator = createChatTitleGenerator(f.config, {
    fetchImpl: async (url, options) => {
      sent = {
        url: String(url),
        key: options.headers.authorization,
        body: JSON.parse(options.body),
      }
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Custom Provider Title' }],
          },
        ],
      })
    },
  })
  await generator.generate([{ role: 'user', content: 'Fixture task' }], {
    owner: 'alice',
  })
  assert.equal(sent.url, 'https://custom.example/v1/responses')
  assert.equal(sent.key, 'Bearer custom-fixture-key')
  assert.equal(sent.body.model, 'custom/model')
  assert.equal(sent.body.reasoning, undefined)
})

test('admission validates account models and efforts; global defaults and a different account cannot grant access', async (t) => {
  const f = await fixture(t, async () => ({
    models: [profile('limited-model', 'high')],
  }))
  await f.providers.save('alice', 'alice-fixture-key')
  const events = new EventStore(f.dataDir)
  const manager = new AgentManager({
    events,
    config: f.config,
    maxConcurrent: 0,
    workspaces: { get: (id) => ({ id, status: 'ready' }) },
  })
  t.after(async () => {
    await manager.shutdown()
    events.close()
  })
  const input = { mode: 'proofs', prompt: 'Fixture proof' }
  const run = await manager.start('alice', 'p1', input)
  assert.equal(run.model, 'limited-model')
  assert.equal(run.effort, 'high')
  await assert.rejects(
    () => manager.start('alice', 'p2', { ...input, model: DEFAULT_MODEL }),
    { status: 400 },
  )
  await assert.rejects(
    () => manager.start('alice', 'p3', { ...input, effort: 'max' }),
    { status: 400 },
  )
  await assert.rejects(() => manager.start('bob', 'p4', input), { status: 428 })
})

test('chat titles use an account model even when its key has no DeepSeek access', async (t) => {
  const f = await fixture(t, async () => ({
    models: [profile('Qwen/Qwen3.8-27B', 'medium')],
  }))
  await f.providers.save('bob', 'bob-fixture-key')
  let sent
  const generator = createChatTitleGenerator(f.config, {
    fetchImpl: async (_url, options) => {
      sent = {
        key: options.headers.authorization,
        body: JSON.parse(options.body),
      }
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'A Fixture Chat Title' }],
          },
        ],
      })
    },
  })
  await generator.generate(
    [{ role: 'user', content: 'Fixture conversation' }],
    { owner: 'bob' },
  )
  assert.equal(sent.key, 'Bearer bob-fixture-key')
  assert.equal(sent.body.model, 'Qwen/Qwen3.8-27B')
  assert.deepEqual(sent.body.reasoning, { effort: 'medium' })
})

test('a queued run cannot send its context to a newly selected provider with the same model ID', async (t) => {
  const f = await fixture(t, async () => ({
    models: [profile('shared/model', null)],
  }))
  await f.providers.save('alice', 'fixture-queued-key')
  const events = new EventStore(f.dataDir)
  let workers = 0
  const manager = new AgentManager({
    events,
    config: f.config,
    maxConcurrent: 0,
    runtime: {
      spawn() {
        workers++
        throw new Error('Unexpected inference worker')
      },
    },
    workspaces: { get: (id) => ({ id, status: 'ready' }) },
  })
  t.after(async () => {
    await manager.shutdown()
    events.close()
  })
  const queued = await manager.start('alice', 'old-project', {
    mode: 'proofs',
    prompt: 'Private fixture context',
  })
  await f.providers.save(
    'alice',
    'fixture-new-provider-key',
    'https://changed.example/v1',
  )
  manager.maxConcurrent = 1
  await manager.start('alice', 'another-project', {
    mode: 'proofs',
    prompt: 'Fixture drain trigger',
  })
  const end = Date.now() + 3000
  while (events.get(queued.id, 'alice').status !== 'failed' && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const failed = events.get(queued.id, 'alice')
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /provider changed while this run was queued/)
  assert.equal(workers, 0)
})

test('native discovery uses a private empty home and requires a fresh authenticated cache', async (t) => {
  const f = await fixture(t)
  const lemexHome = path.join(f.dataDir, 'native')
  await fs.mkdir(path.join(lemexHome, 'bin'), { recursive: true })
  await fs.mkdir(f.discovery.directory)
  const script = `#!${process.execPath}
const fs = require('node:fs'), readline = require('node:readline');
const home = process.env.LEMEX_HOME;
if (process.env.HOME !== home || process.argv.join(' ').includes(process.env.LEMEX_API_KEY) || fs.existsSync(home+'/auth.json')) process.exit(1);
const config = fs.readFileSync(home+'/config.toml','utf8');
if (!config.includes('base_url = "https://provider.example/v1"') || config.includes(process.env.LEMEX_API_KEY)) process.exit(2);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line); if (!req.id) return;
 if(req.method==='model/list' && process.env.LEMEX_API_KEY!=='fallback-fixture-key') fs.writeFileSync(home+'/models_cache.json',JSON.stringify({identity:'fixture-auth-identity',fetched_at:new Date().toISOString(),models:[{slug:'native/available',visibility:'list'}]}));
 process.stdout.write(JSON.stringify({id:req.id,result:req.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');
});`
  await fs.writeFile(path.join(lemexHome, 'bin/lemex'), script, { mode: 0o700 })
  const invoke = (key) =>
    discoverNativeModels({
      config: { ...f.config, lemexHome },
      provider: {
        LEMEX_API_KEY: key,
        LEMEX_BASE_URL: 'https://provider.example/v1',
      },
      directory: f.discovery.directory,
      fetchImpl: async () =>
        Response.json({ data: [{ id: 'native/available' }] }),
    })
  assert.equal(
    (await invoke('live-fixture-key')).models[0].slug,
    'native/available',
  )
  assert.deepEqual(await fs.readdir(f.discovery.directory), [])
  await assert.rejects(
    () => invoke('fallback-fixture-key'),
    /Could not load models/,
  )
  assert.deepEqual(await fs.readdir(f.discovery.directory), [])
})
