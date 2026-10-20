import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import {
  ProviderRequests,
  providerRequestsFor,
  providerRequestConfig,
  providerLimitMessage,
} from '../provider-requests.mjs'
import { RCP_BASE_URL } from '../provider-endpoint.mjs'
import { createChatTitleGenerator } from '../chat-titles.mjs'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'
import { ChatStore } from '../chats.mjs'
import { repairProjectSetup } from '../setup-repair.mjs'
import { createStudio } from '../studio.mjs'
import { loadCapacity } from '../capacity.mjs'
import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'

const rcp = (key = 'fixture-key-one') => ({
  LEMEX_BASE_URL: RCP_BASE_URL,
  LEMEX_API_KEY: key,
})
const custom = {
  LEMEX_BASE_URL: 'https://provider.example/v1',
  LEMEX_API_KEY: 'fixture-key-one',
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const until = async (condition) => {
  const deadline = Date.now() + 2000
  while (!condition() && Date.now() < deadline) await tick()
  assert(condition(), 'Expected asynchronous state change')
}

test('RCP reservations serialize the same credential, including across accounts, but independent keys and custom providers proceed', () => {
  const requests = new ProviderRequests()
  const first = requests.reserve(rcp()),
    second = requests.reserve(rcp()),
    different = requests.reserve(rcp('other-key'))
  const customA = requests.reserve(custom),
    customB = requests.reserve(custom)
  assert(first.tryAcquire())
  assert(!second.tryAcquire())
  assert(different.tryAcquire())
  assert(customA.tryAcquire())
  assert(customB.tryAcquire())
  first.release()
  first.release()
  assert(second.tryAcquire())
  for (const item of [second, different, customA, customB]) item.release()
})

test('foreground reservations take priority over pending titles without interrupting an active title', () => {
  const requests = new ProviderRequests()
  const active = requests.reserve(rcp(), { background: true })
  assert(active.tryAcquire())
  const title = requests.reserve(rcp(), { background: true })
  const foreground = requests.reserve(rcp())
  assert(!foreground.tryAcquire())
  active.release()
  assert(!title.tryAcquire())
  assert(foreground.tryAcquire())
  foreground.release()
  assert(title.tryAcquire())
  title.release()
})

test('background request slots count only acquired keys and remain bounded across providers', async () => {
  const requests = new ProviderRequests()
  const foreground = requests.reserve(rcp())
  assert(foreground.tryAcquire())
  const blocked = requests.reserve(rcp(), { background: true })
  assert(!blocked.tryAcquire())
  const first = requests.reserve(rcp('other-key'), { background: true })
  const second = requests.reserve(custom, { background: true })
  const third = requests.reserve(custom, { background: true })
  assert(first.tryAcquire())
  assert(second.tryAcquire())
  assert(!third.tryAcquire())
  const abort = new AbortController()
  const pending = blocked.wait(abort.signal)
  abort.abort()
  await assert.rejects(pending)
  assert(!third.tryAcquire(), 'Cancelling a wait must not free an active slot')
  first.release()
  assert(third.tryAcquire())
  for (const reservation of [foreground, second, third]) reservation.release()
  assert.equal(requests.listenerCount('available'), 0)
})

test('reservation waits cancel promptly, remove listeners, and enforce a bounded pending queue', async () => {
  const requests = new ProviderRequests({ maxPendingPerKey: 1 })
  const first = requests.reserve(rcp())
  assert(first.tryAcquire())
  const waiting = requests.reserve(rcp()),
    abort = new AbortController(),
    notices = []
  const pending = waiting.wait(abort.signal, (message) => notices.push(message))
  assert.throws(() => requests.reserve(rcp()), { status: 429 })
  abort.abort(new Error('Cancelled fixture'))
  await assert.rejects(pending, /Cancelled fixture/)
  assert.equal(requests.listenerCount('available'), 0)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /start automatically/)
  const next = requests.reserve(rcp())
  first.release()
  await next.wait()
  next.release()
  assert.equal(requests.listenerCount('available'), 0)
  const released = requests.reserve(rcp())
  released.release()
  await assert.rejects(released.wait(), /cancelled/)
})

test('provider changes invalidate a reservation and RCP config disables nested model concurrency only for RCP', () => {
  const requests = new ProviderRequests(),
    provider = rcp(),
    reservation = requests.reserve(provider)
  assert(
    reservation.matches({ ...provider, LEMEX_BASE_URL: RCP_BASE_URL + '/' }),
  )
  assert(!reservation.matches(rcp('new-key')))
  assert(!reservation.matches(custom))
  const values = providerRequestConfig(provider).join('\n')
  assert.match(values, /features.multi_agent = false/)
  assert.match(values, /features.multi_agent_v2 = false/)
  assert.match(values, /features.concurrent_reasoning_summaries = false/)
  assert.deepEqual(providerRequestConfig(custom), [])
  reservation.release()
})

test('RCP errors distinguish retryable busy requests from exhausted quota using fixed non-sensitive guidance', () => {
  const secret = 'private-token-123'
  const provider = rcp(secret)
  const busy = providerLimitMessage(
    {
      message: 'arbitrary ' + secret,
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
    },
    provider,
    { retrying: true },
  )
  assert.match(busy, /retrying automatically/)
  assert(!busy.includes(secret))
  const ended = providerLimitMessage(
    { message: 'Too many concurrent requests ' + secret },
    provider,
  )
  assert.match(ended, /including requests from other apps/)
  assert(!ended.includes(secret))
  const quota = providerLimitMessage(
    { message: secret, codexErrorInfo: 'usageLimitExceeded' },
    provider,
  )
  assert.match(quota, /usage quota/)
  assert.doesNotMatch(quota, /retrying automatically/)
  assert(!quota.includes(secret))
  assert.equal(providerLimitMessage('HTTP 429', custom), null)
  assert.equal(providerLimitMessage('Lean type mismatch', provider), null)
})

const titleAnswer = () =>
  Response.json({
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Explain Nat.add_comm' }],
      },
    ],
  })

test('account-scoped titles share the foreground coordinator, have a separate wait budget, and release on errors', async () => {
  const config = {
    provider: rcp(),
    providerForUser: async () => rcp(),
    modelsForUser: async () => ({
      defaultModel: 'fixture',
      models: [{ id: 'fixture' }],
    }),
  }
  const foreground = providerRequestsFor(config).reserve(rcp())
  assert(foreground.tryAcquire())
  let calls = 0
  const title = createChatTitleGenerator(config, {
    timeoutMs: 5,
    fetchImpl: async () => {
      calls++
      return titleAnswer()
    },
  })
  const pending = title.generate(
    [{ role: 'user', content: 'Explain Nat.add_comm' }],
    { owner: 'alice' },
  )
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(calls, 0)
  foreground.release()
  assert.equal((await pending).title, 'Explain Nat.add_comm')
  assert.equal(calls, 1)
  const failing = createChatTitleGenerator(config, {
    fetchImpl: async () =>
      new Response('secret upstream body', { status: 429 }),
  })
  await assert.rejects(
    failing.generate([{ role: 'user', content: 'Explain theorem' }], {
      owner: 'alice',
    }),
    (error) =>
      error.status === 429 &&
      /RCP/.test(error.message) &&
      !error.message.includes('secret upstream body'),
  )
  const next = providerRequestsFor(config).reserve(rcp())
  assert(next.tryAcquire())
  next.release()
})

test('a title wait expires with safe actionable guidance, frees its queue entry, and never sends a late request', async () => {
  const config = {
    provider: rcp(),
    defaultModel: 'fixture',
    models: [{ id: 'fixture' }],
  }
  const requests = providerRequestsFor(config)
  const foreground = requests.reserve(rcp())
  assert(foreground.tryAcquire())
  let calls = 0
  const generator = createChatTitleGenerator(config, {
    waitTimeoutMs: 5,
    fetchImpl: async () => {
      calls++
      return titleAnswer()
    },
  })
  await assert.rejects(
    generator.generate([{ role: 'user', content: 'Name this proof' }]),
    (error) =>
      error.status === 504 &&
      /waiting for this RCP key or a naming slot/.test(error.message) &&
      /manually/.test(error.message),
  )
  assert.equal(requests.listenerCount('available'), 0)
  foreground.release()
  await tick()
  assert.equal(calls, 0)
  assert.equal(
    (await generator.generate([{ role: 'user', content: 'Name this proof' }]))
      .title,
    'Explain Nat.add_comm',
  )
  assert.equal(calls, 1)
})

test('a queued title rejects a changed saved key or provider before sending any request', async () => {
  for (const replacement of [rcp('updated-key'), custom]) {
    let provider = rcp(),
      calls = 0
    const config = {
      provider: rcp(),
      providerForUser: async () => provider,
      modelsForUser: async () => ({
        defaultModel: 'fixture',
        models: [{ id: 'fixture' }],
      }),
    }
    const requests = providerRequestsFor(config)
    const foreground = requests.reserve(provider)
    assert(foreground.tryAcquire())
    const generator = createChatTitleGenerator(config, {
      fetchImpl: async () => {
        calls++
        return titleAnswer()
      },
    })
    const pending = generator.generate(
      [{ role: 'user', content: 'Explain Nat.add_comm' }],
      { owner: 'alice' },
    )
    await until(() => requests.listenerCount('available') === 1)
    provider = replacement
    foreground.release()
    await assert.rejects(
      pending,
      (error) =>
        error.status === 409 &&
        /API key or provider changed/.test(error.message),
    )
    assert.equal(calls, 0)
    const next = requests.reserve(rcp())
    assert(next.tryAcquire())
    next.release()
    assert.equal(requests.listenerCount('available'), 0)
  }
})

test('blocked automatic titles do not keep another account from naming its chat', async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-title-fairness-'),
  )
  const events = new EventStore(dataDir)
  const config = {
    provider: rcp(),
    providerForUser: async (owner) => rcp(owner),
    modelsForUser: async () => ({
      defaultModel: 'fixture',
      models: [{ id: 'fixture' }],
    }),
  }
  const requests = providerRequestsFor(config)
  const foreground = requests.reserve(rcp('alice'))
  assert(foreground.tryAcquire())
  const calls = []
  const chats = new ChatStore({
    dataDir,
    events,
    workspaces: { get: (id, owner) => ({ id, owner, name: 'Proofs' }) },
    titleGenerator: createChatTitleGenerator(config, {
      fetchImpl: async (_url, init) => {
        calls.push(init.headers.authorization)
        return titleAnswer()
      },
    }),
  })
  chats.init()
  t.after(async () => {
    chats.close()
    foreground.release()
    await tick()
    events.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const create = (owner) => {
    const chat = chats.create(owner, owner + '-project')
    const run = events.create(owner, {
      kind: 'agent',
      projectId: chat.projectId,
      chatId: chat.id,
      prompt: 'Explain Nat.add_comm',
      mode: 'search',
    })
    chats.appendRun(chat.id, owner, run)
    return chat
  }
  const alice = Array.from({ length: 18 }, () => create('alice'))
  await until(() => requests.listenerCount('available') === 3)
  await until(() =>
    alice
      .slice(3)
      .every(
        (chat) => chats.get(chat.id, 'alice').titleStatus === 'unavailable',
      ),
  )
  assert.equal(chats.titleTasks.size, 3)
  const bob = create('bob')
  await until(() => chats.get(bob.id, 'bob').titleStatus === 'ready')
  assert.deepEqual(calls, ['Bearer bob'])
  assert(
    alice
      .slice(0, 3)
      .every((chat) => chats.get(chat.id, 'alice').titleStatus === 'pending'),
  )
  foreground.release()
  await until(() =>
    alice
      .slice(0, 3)
      .every((chat) => chats.get(chat.id, 'alice').titleStatus === 'ready'),
  )
  assert.deepEqual(calls, [
    'Bearer bob',
    'Bearer alice',
    'Bearer alice',
    'Bearer alice',
  ])
})

test('unrelated filesystem and tool errors are never relabelled as RCP limits', async (t) => {
  for (const message of [
    'Could not open p-429.lean',
    'GitHub rate limit prevented reading a dependency',
  ]) {
    const f = await managerFixture(t)
    const job = await f.start('alice', 'one')
    await until(() => f.snapshots.length === 1)
    f.snapshots[0].reject(new Error(message))
    await until(() => f.events.get(job.id).status === 'failed')
    assert.equal(f.events.get(job.id).error, message)
    await assert.rejects(
      repairProjectSetup({
        config: {
          provider: rcp(),
          defaultModel: 'fixture',
          models: [{ id: 'fixture' }],
        },
        runtime: {
          home: async () => {
            throw new Error(message)
          },
        },
        owner: 'alice',
        root: '/fixture',
        project: { name: 'Fixture' },
      }),
      { message },
    )
  }
})

test('studio setup repair receives its full execution budget after the RCP key wait and can be stopped while queued', async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-repair-deadline-'),
  )
  let startedSignal
  const runtime = {
    init: async () => {},
    info: () => ({ ready: true }),
    templates: () => [],
    shutdown: async () => {},
    home: async () => {
      const home = path.join(dataDir, 'home')
      await fs.mkdir(path.join(home, '.lemex'), { recursive: true })
      return home
    },
    spawnWhenAvailable: async (_root, _args, { signal }) => {
      startedSignal = signal
      const child = nativeFixture(() => {})
      signal.addEventListener('abort', () => child.kill(), { once: true })
      return child
    },
  }
  const config = {
    provider: rcp(),
    defaultModel: 'fixture',
    models: [{ id: 'fixture' }],
    lemex: {},
    redact: String,
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    config,
    capacity: { ...loadCapacity({}), setupRepairTimeoutMs: 25 },
    modelDiscoverer: fixtureModelDiscovery,
  })
  const foreground = providerRequestsFor(config).reserve(rcp())
  assert(foreground.tryAcquire())
  t.after(async () => {
    foreground.release()
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  await studio.providers.save('owner', 'fixture-key-one')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cancelled = new AbortController(),
    phases = []
  const args = {
    root: dataDir,
    owner: 'owner',
    project: { name: 'Fixture' },
    onProgress: (value) => phases.push(value),
  }
  const stopped = studio.workspaces.setupRepair({
    ...args,
    signal: cancelled.signal,
  })
  await until(() => phases.includes('waiting-for-rcp'))
  t.mock.timers.tick(1000)
  assert.equal(startedSignal, undefined)
  cancelled.abort(new Error('Stop queued fixture'))
  await assert.rejects(stopped, /Stop queued fixture/)
  phases.length = 0
  const pending = studio.workspaces.setupRepair(args)
  const rejected = assert.rejects(
    pending,
    /setup repair reached its time limit/,
  )
  await until(() => phases.includes('waiting-for-rcp'))
  t.mock.timers.tick(1000)
  assert.equal(startedSignal, undefined)
  foreground.release()
  await until(() => !!startedSignal)
  assert.equal(startedSignal.aborted, false)
  t.mock.timers.tick(24)
  assert.equal(startedSignal.aborted, false)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(startedSignal.aborted, true)
  t.mock.timers.reset()
})

async function managerFixture(t, { title = false } = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-provider-queue-'),
  )
  const events = new EventStore(root),
    snapshots = [],
    providers = new Map([
      ['alice', rcp()],
      ['bob', rcp()],
      ['carol', rcp('other-key')],
    ])
  const config = {
    provider: rcp(),
    providerForUser: async (owner) => providers.get(owner),
    models: [{ id: 'fixture' }],
    defaultModel: 'fixture',
    redact: String,
  }
  let titleCalls = 0,
    titleTask
  const generator = createChatTitleGenerator(config, {
    fetchImpl: async () => {
      titleCalls++
      return titleAnswer()
    },
  })
  const workspaces = {
    get: (id, owner) => ({
      id,
      owner,
      status: 'ready',
      root,
      toolchain: 'leanprover/lean4:v4.34.1',
    }),
    snapshot: (id, owner) =>
      new Promise((_resolve, reject) => snapshots.push({ id, owner, reject })),
  }
  const manager = new AgentManager({
    runtime: {},
    workspaces,
    events,
    config,
    settings: {},
    maxConcurrent: 2,
    ...(title
      ? {
          chats: {
            get: (_id, owner) => ({ projectId: owner + '-one' }),
            history: () => ({ runs: [] }),
            appendRun: (_id, owner) => {
              titleTask = generator.generate(
                [{ role: 'user', content: 'Explain Nat.add_comm' }],
                { owner },
              )
            },
          },
        }
      : {}),
  })
  t.after(async () => {
    manager.stopping = true
    for (const snapshot of snapshots) snapshot.reject(new Error('End fixture'))
    await manager.shutdown()
    await titleTask
    events.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const start = (owner, suffix) =>
    manager.start(owner, owner + '-' + suffix, {
      mode: 'search',
      prompt: 'Explain Nat.add_comm',
      ...(title ? { chatId: 'chat' } : {}),
    })
  return {
    manager,
    events,
    snapshots,
    providers,
    config,
    start,
    get titleCalls() {
      return titleCalls
    },
    get titleTask() {
      return titleTask
    },
  }
}

test('blocked same-key agents take no global slot and do not block another key; queued cancellation is immediate', async (t) => {
  const f = await managerFixture(t)
  const first = await f.start('alice', 'one')
  await until(() => f.snapshots.length === 1)
  const blocked = await f.start('bob', 'one')
  await until(
    () => f.events.get(blocked.id).progress.label === 'Waiting for RCP key',
  )
  assert.equal(f.manager.running, 1)
  const other = await f.start('carol', 'one')
  await until(() => f.snapshots.length === 2)
  assert.equal(f.manager.running, 2)
  assert.equal(f.events.get(first.id).status, 'running')
  assert.equal(f.events.get(other.id).status, 'running')
  assert.equal(f.events.get(blocked.id).status, 'queued')
  assert.match(
    f.events.get(blocked.id).progress.detail,
    /one RCP task at a time per key/,
  )
  await f.manager.stop('bob', blocked.id)
  assert.equal(f.events.get(blocked.id).status, 'cancelled')
  assert(!f.snapshots.some((item) => item.owner === 'bob'))
})

test('foreground admission reserves the RCP key before automatic chat naming can call the provider', async (t) => {
  const f = await managerFixture(t, { title: true })
  const job = await f.start('alice', 'one')
  await until(() => f.snapshots.length === 1)
  assert.equal(f.titleCalls, 0)
  f.snapshots[0].reject(new Error('End foreground fixture'))
  await until(() => f.events.get(job.id).status === 'failed')
  await f.titleTask
  assert.equal(f.titleCalls, 1)
})

test('a long RCP run defers automatic naming without queue capacity and names once only after worker cleanup', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-deferred-title-'),
  )
  await fs.mkdir(path.join(root, '.lemex'))
  const events = new EventStore(root)
  const config = {
    provider: rcp(),
    models: [{ id: 'fixture' }],
    defaultModel: 'fixture',
    redact: String,
  }
  const workspaces = {
    get: (id, owner) => ({
      id,
      owner,
      name: 'Fixture',
      root,
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    }),
    snapshot: async () => ({ root, sourceRevision: 'fixture' }),
    changes: async () => [],
  }
  let calls = 0,
    finish,
    cleanup
  const child = nativeFixture((send) => {
    finish = () =>
      send({
        method: 'turn/completed',
        params: { turn: { id: 'turn', status: 'completed' } },
      })
  })
  child.workerStopped = new Promise((resolve) => {
    cleanup = resolve
  })
  const chats = new ChatStore({
    dataDir: root,
    events,
    workspaces,
    titleGenerator: createChatTitleGenerator(config, {
      fetchImpl: async () => {
        calls++
        return titleAnswer()
      },
    }),
  })
  chats.init()
  const manager = new AgentManager({
    events,
    config,
    chats,
    workspaces,
    runtime: { home: async () => root, spawn: () => child },
    settings: { get: async () => ({ tools: {}, extraInstructions: '' }) },
  })
  t.after(async () => {
    finish?.()
    cleanup()
    t.mock.timers.reset()
    await manager.shutdown()
    chats.close()
    events.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const chat = chats.create('alice', 'project')
  const run = await manager.start('alice', 'project', {
    chatId: chat.id,
    mode: 'search',
    prompt: 'Explain Nat.add_comm',
  })
  await until(() => !!finish)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.timers.tick(60_000)
  await tick()
  assert.equal(calls, 0)
  assert.equal(chats.titleTasks.size, 0)
  assert.equal(chats.titleQueue.length, 0)
  assert.equal(chats.get(chat.id, 'alice').titleStatus, 'pending')
  finish()
  await until(() => events.get(run.id).status === 'completed')
  assert.equal(
    calls,
    0,
    'Native close alone must not start another same-key request',
  )
  assert.equal(chats.titleTasks.size, 0)
  cleanup()
  await until(() => chats.get(chat.id, 'alice').titleStatus === 'ready')
  assert.equal(chats.get(chat.id, 'alice').title, 'Explain Nat.add_comm')
  chats.finishRun(run.id)
  await tick()
  assert.equal(calls, 1)
})

test('changed RCP credentials while queued fail safely instead of bypassing the new key gate', async (t) => {
  const f = await managerFixture(t)
  await f.start('alice', 'one')
  await until(() => f.snapshots.length === 1)
  const queued = await f.start('bob', 'one')
  f.providers.set('bob', rcp('changed-key'))
  f.snapshots[0].reject(new Error('End first fixture'))
  await until(() => f.events.get(queued.id).status === 'failed')
  assert.match(f.events.get(queued.id).error, /API key or provider changed/)
  assert.equal(f.snapshots.length, 1)
})

test('setup repair uses the same RCP gate before occupying an assistant slot', async (t) => {
  const f = await managerFixture(t)
  await f.start('alice', 'one')
  await until(() => f.snapshots.length === 1)
  let ran = false,
    waiting = ''
  const cancelled = new AbortController()
  const repair = f.manager.runSetupRepair(
    () => {
      ran = true
    },
    {
      provider: rcp(),
      signal: cancelled.signal,
      onProviderQueued: (message) => {
        waiting = message
      },
    },
  )
  await until(() => !!waiting)
  assert.equal(f.manager.running, 1)
  assert(!ran)
  cancelled.abort(new Error('Stop queued repair'))
  await assert.rejects(repair, /Stop queued repair/)
  const other = f.manager.runSetupRepair(
    (_signal, reservation) => {
      assert(reservation.matches(rcp('other-key')))
      assert(reservation.tryAcquire())
      ran = true
    },
    { provider: rcp('other-key') },
  )
  await other
  assert(ran)
})

function nativeFixture(onTurn, { turnError } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let closed = false
  const send = (message) => {
    if (!closed) child.stdout.write(JSON.stringify(message) + '\n')
  }
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        const request = JSON.parse(line)
        if (request.id === undefined) continue
        queueMicrotask(() => {
          if (request.method === 'turn/start' && turnError) {
            send({
              id: request.id,
              error: { message: turnError, code: -32000 },
            })
            return
          }
          send({
            id: request.id,
            result:
              request.method === 'thread/start'
                ? { thread: { id: 'thread' } }
                : request.method === 'turn/start'
                  ? { turn: { id: 'turn' } }
                  : {},
          })
          if (request.method === 'turn/start') onTurn(send)
        })
      }
      callback()
    },
  })
  child.kill = () => {
    if (!closed) {
      closed = true
      child.stdout.end()
      queueMicrotask(() => child.emit('close', 0))
    }
    return true
  }
  return child
}

test('turn/start provider rejections retain safe RCP guidance for agents and setup repair', async (t) => {
  for (const setup of [false, true])
    await t.test(setup ? 'setup' : 'agent', async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'leanflow-provider-start-error-'),
      )
      await fs.mkdir(path.join(root, '.lemex'))
      const events = new EventStore(root)
      const child = nativeFixture(
        () => assert.fail('Rejected provider turn must not execute'),
        { turnError: 'HTTP 429 private upstream fixture-key-one' },
      )
      const config = {
        provider: rcp(),
        models: [{ id: 'fixture' }],
        defaultModel: 'fixture',
        redact: String,
      }
      const runtime = {
        home: async () => root,
        spawn: () => child,
        spawnWhenAvailable: async () => child,
      }
      const workspaces = {
        get: (id, owner) => ({
          id,
          owner,
          root,
          status: 'ready',
          toolchain: 'leanprover/lean4:v4.34.1',
        }),
        snapshot: async () => ({ root, sourceRevision: 'fixture' }),
      }
      const manager = new AgentManager({
        events,
        config,
        runtime,
        workspaces,
        settings: { get: async () => ({ tools: {}, extraInstructions: '' }) },
      })
      t.after(async () => {
        await manager.shutdown()
        events.close()
        await fs.rm(root, { recursive: true, force: true })
      })
      if (setup) {
        await assert.rejects(
          repairProjectSetup({
            config,
            runtime,
            root,
            owner: 'alice',
            project: { name: 'Fixture' },
          }),
          (error) =>
            /RCP could not accept/.test(error.message) &&
            !/private|fixture-key/.test(error.message),
        )
      } else {
        const run = await manager.start('alice', 'fixture', {
          mode: 'search',
          prompt: 'Explain Nat.add_comm',
        })
        await until(() => events.get(run.id).status === 'failed')
        assert.match(events.get(run.id).error, /RCP could not accept/)
        assert.doesNotMatch(events.get(run.id).error, /private|fixture-key/)
      }
    })
})

test('native RCP retry status survives turn startup and resumes, while quota failures show safe guidance', async (t) => {
  for (const exhausted of [false, true])
    await t.test(exhausted ? 'quota' : 'retry and recover', async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'leanflow-rcp-native-'),
      )
      await fs.mkdir(path.join(root, '.lemex'))
      const events = new EventStore(root)
      let finish
      const child = nativeFixture((send) => {
        send({
          method: 'error',
          params: {
            willRetry: true,
            error: {
              message: 'private upstream fixture-key-one',
              codexErrorInfo: 'rateLimitExceeded',
            },
          },
        })
        finish = () => {
          if (!exhausted)
            send({
              method: 'item/agentMessage/delta',
              params: {
                itemId: 'answer',
                delta: 'The result follows by commutativity.',
              },
            })
          send({
            method: 'turn/completed',
            params: {
              turn: {
                id: 'turn',
                status: exhausted ? 'failed' : 'completed',
                ...(exhausted
                  ? {
                      error: {
                        message: 'private upstream fixture-key-one',
                        codexErrorInfo: 'usageLimitExceeded',
                      },
                    }
                  : {}),
              },
            },
          })
        }
      })
      const manager = new AgentManager({
        events,
        config: {
          provider: rcp(),
          models: [{ id: 'fixture' }],
          defaultModel: 'fixture',
          redact: String,
        },
        runtime: { home: async () => root, spawn: () => child },
        workspaces: {
          get: (id, owner) => ({
            id,
            owner,
            root,
            status: 'ready',
            toolchain: 'leanprover/lean4:v4.34.1',
          }),
          snapshot: async () => ({ root, sourceRevision: 'fixture' }),
          changes: async () => [],
        },
        settings: { get: async () => ({ tools: {}, extraInstructions: '' }) },
      })
      t.after(async () => {
        finish?.()
        await manager.shutdown()
        events.close()
        await fs.rm(root, { recursive: true, force: true })
      })
      const job = await manager.start('alice', 'fixture', {
        mode: 'search',
        prompt: 'Explain Nat.add_comm',
      })
      await until(() => events.get(job.id).progress.label === 'Waiting for RCP')
      await tick()
      assert.equal(
        events.get(job.id).progress.label,
        'Waiting for RCP',
        'turn/start must not erase a provider retry notice',
      )
      assert.match(events.get(job.id).progress.detail, /retrying automatically/)
      assert(!events.get(job.id).log.includes('private upstream'))
      finish()
      await until(() =>
        ['failed', 'completed'].includes(events.get(job.id).status),
      )
      if (exhausted) {
        assert.equal(events.get(job.id).status, 'failed')
        assert.match(events.get(job.id).error, /usage quota/)
        assert(!events.get(job.id).error.includes('fixture-key-one'))
      } else {
        assert.equal(events.get(job.id).status, 'completed')
        assert(
          events
            .eventPage(job.id, 0)
            .some(
              (event) =>
                event.type === 'progress' && event.data.label === 'Working',
            ),
        )
      }
      const nativeConfig = await fs.readFile(
        path.join(root, '.lemex/config.toml'),
        'utf8',
      )
      assert.match(nativeConfig, /features.multi_agent = false/)
      assert.match(
        nativeConfig,
        /features.concurrent_reasoning_summaries = false/,
      )
    })
})

test('setup keeps the RCP reservation until actual worker removal and surfaces cleanup failure', async (t) => {
  for (const fails of [false, true])
    await t.test(fails ? 'failed removal' : 'delayed removal', async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'leanflow-rcp-cleanup-'),
      )
      t.after(() => fs.rm(root, { recursive: true, force: true }))
      await fs.mkdir(path.join(root, '.lemex'))
      const config = {
        provider: rcp(),
        defaultModel: 'fixture',
        models: [{ id: 'fixture' }],
        redact: String,
      }
      let remove,
        rejectRemoval,
        clientClosed = false,
        finished = false
      const child = nativeFixture((send) =>
        send({
          method: 'turn/completed',
          params: { turn: { status: 'completed' } },
        }),
      )
      child.once('close', () => {
        clientClosed = true
      })
      child.workerStopped = new Promise((resolve, reject) => {
        remove = resolve
        rejectRemoval = reject
      })
      child.workerStopped.catch(() => {})
      const repair = repairProjectSetup({
        root,
        owner: 'alice',
        project: { name: 'Fixture' },
        error: 'Fixture setup',
        config,
        runtime: {
          home: async () => root,
          spawnWhenAvailable: async () => child,
        },
      })
      repair.then(
        () => {
          finished = true
        },
        () => {
          finished = true
        },
      )
      await until(() => clientClosed)
      const waiting = providerRequestsFor(config).reserve(rcp())
      assert(
        !waiting.tryAcquire(),
        'client close is not proof that the native worker has stopped',
      )
      assert(!finished)
      if (fails) {
        const cleanup = Object.assign(new Error('Worker removal failed'), {
          workerCleanup: true,
        })
        rejectRemoval(cleanup)
        await assert.rejects(
          repair,
          (error) => error === cleanup && error.workerCleanup,
        )
      } else {
        remove()
        await repair
      }
      assert(waiting.tryAcquire())
      waiting.release()
    })
})
