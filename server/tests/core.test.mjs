import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { Auth, sameOrigin } from '../auth.mjs'
import { AgentRpc, LspFrames, frame, validateClientUris } from '../rpc.mjs'
import {
  proofRisks,
  declarationNames,
  maskLean,
  verifyCandidate,
} from '../verification.mjs'
import { EventStore, JobManager } from '../events.mjs'
import { Settings } from '../settings.mjs'
import { createStudio } from '../studio.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const TOOLCHAIN = 'leanprover/lean4:v4.34.1'

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-core-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function childProcess() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.requests = []
  child.killed = false
  child.stdin.on('data', (chunk) => child.requests.push(chunk.toString()))
  child.kill = () => {
    if (child.killed) return
    child.killed = true
    queueMicrotask(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0)
    })
  }
  return child
}

class FakeRuntime {
  calls = []
  spawned = []
  async init() {
    return this
  }
  info() {
    return {
      ready: true,
      active: this.spawned.filter((child) => !child.killed).length,
    }
  }
  templates() {
    return [{ id: 'lean', name: 'Lean', toolchain: TOOLCHAIN, ready: true }]
  }
  templateRoot() {
    return null
  }
  async prepareToolchain() {}
  async run(root, args, options = {}) {
    this.calls.push({ root, args, options })
    if (args[0] === 'lake' && args.includes('update')) {
      await fs.mkdir(path.join(root, '.lake'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[]}',
      )
    }
    if (args[0] === 'git' && args.includes('init'))
      await fs.mkdir(path.join(root, '.git'), { recursive: true })
    if (args[0] === 'git' && args.includes('rev-parse'))
      return { code: 1, stdout: '', stderr: 'No commit yet' }
    if (args[0] === 'git' && args.includes('status'))
      return { code: 0, stdout: '## No commits yet on main\0', stderr: '' }
    return { code: 0, stdout: 'Lean version 4.34.1\n', stderr: '' }
  }
  spawn(root, args, options) {
    const child = childProcess()
    Object.assign(child, { root, args, options })
    this.spawned.push(child)
    return child
  }
  async shutdown() {
    this.spawned.forEach((child) => child.kill())
  }
}

async function fixture(t, capacity) {
  const dataDir = await temp(t),
    runtime = new FakeRuntime()
  const providerSecret = 'test-provider-secret'
  const config = {
    defaultModel: 'test-model',
    models: [{ id: 'test-model', name: 'Test model' }],
    provider: { LEMEX_API_KEY: providerSecret },
    lemex: { configured: true, revision: 'test-revision' },
    redact: (value) => String(value).split(providerSecret).join('[redacted]'),
  }
  const studio = await createStudio({ dataDir, runtime, config, capacity })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(() => studio.close())
  const url = `http://127.0.0.1:${studio.server.address().port}`
  const token = (
    await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')
  ).trim()
  const otherToken = 'collaborator-test-token'
  studio.auth.users.push({
    id: 'bob',
    name: 'Bob',
    tokenHash: hash(otherToken),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth', 'users.json'),
    JSON.stringify(studio.auth.users),
  )
  const project = await studio.workspaces.create('owner', {
    preset: 'lean',
    name: 'Owner project',
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  const request = (endpoint, options = {}, access = token) =>
    fetch(url + endpoint, {
      ...options,
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
        ...options.headers,
      },
    })
  return {
    ...studio,
    dataDir,
    url,
    token,
    otherToken,
    project,
    runtime,
    request,
    providerSecret,
  }
}

function rejectedSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 2000 })
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      ws.terminate()
      resolve(res.statusCode)
    })
    ws.once('open', () => {
      ws.close()
      resolve(101)
    })
    ws.on('error', (error) => {
      if (
        ws.readyState !== WebSocket.CLOSING &&
        ws.readyState !== WebSocket.CLOSED
      )
        reject(error)
    })
  })
}

function finishedJob(events, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      events.off(id, update)
      reject(new Error('Job did not finish'))
    }, 3000)
    const update = (event) => {
      if (
        event.type === 'status' &&
        ['completed', 'failed', 'cancelled'].includes(event.data.status)
      ) {
        clearTimeout(timer)
        events.off(id, update)
        resolve(events.get(id))
      }
    }
    events.on(id, update)
  })
}

test('authentication persists private tokens, signs cookies, and rejects tampering and expired sessions', async (t) => {
  const directory = await temp(t),
    auth = new Auth(directory)
  await auth.init()
  const token = (
    await fs.readFile(path.join(auth.dir, 'owner.token'), 'utf8')
  ).trim()
  const user = await auth.login(token, 'local')
  assert.deepEqual(auth.public(user), { id: 'owner', name: 'Owner' })
  assert.ok(!JSON.stringify(auth.users).includes(token))
  assert.equal(
    (await fs.stat(path.join(auth.dir, 'owner.token'))).mode & 0o777,
    0o600,
  )
  const cookie = auth.cookie(user, true)
  for (const attribute of [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=43200',
    'Secure',
  ])
    assert.ok(cookie.includes(attribute))
  const value = cookie.split(';')[0]
  assert.equal(auth.identify({ headers: { cookie: value } }).id, user.id)
  assert.equal(auth.identify({ headers: { cookie: value + 'tampered' } }), null)
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, expires: Date.now() - 1 }),
  ).toString('base64url')
  assert.equal(
    auth.identify({
      headers: { cookie: `lemex_web=${payload}.${auth.sign(payload)}` },
    }),
    null,
  )
  const restarted = new Auth(directory)
  await restarted.init()
  assert.equal(restarted.identify({ headers: { cookie: value } }).id, user.id)
  assert.equal(
    restarted.identify({ headers: { authorization: `Bearer ${token}` } }).id,
    user.id,
  )
  assert.equal(
    sameOrigin(
      { headers: { origin: 'https://evil.test', host: 'lean.test' } },
      'https://lean.test',
    ),
    false,
  )
  assert.equal(
    sameOrigin(
      { headers: { origin: 'https://lean.test', host: 'lean.test' } },
      'https://lean.test',
    ),
    true,
  )
})

test('failed login attempts are bounded', async (t) => {
  const auth = new Auth(await temp(t))
  await auth.init()
  for (let i = 0; i < 12; i++)
    await assert.rejects(auth.login('invalid-token', 'one-client'), {
      status: 401,
    })
  await assert.rejects(auth.login('invalid-token', 'one-client'), {
    status: 429,
  })
})

test('removing a collaborator immediately revokes both their cookie and access token', async (t) => {
  const auth = new Auth(await temp(t))
  await auth.init()
  const token = (
    await fs.readFile(path.join(auth.dir, 'owner.token'), 'utf8')
  ).trim()
  const user = await auth.login(token, 'local')
  const cookie = auth.cookie(user).split(';')[0]
  assert.equal(auth.identify({ headers: { cookie } }).id, 'owner')
  assert.equal(
    auth.identify({ headers: { authorization: `Bearer ${token}` } }).id,
    'owner',
  )
  await fs.writeFile(path.join(auth.dir, 'users.json'), '[]', { mode: 0o600 })
  assert.equal(auth.identify({ headers: { cookie } }), null)
  assert.equal(
    auth.identify({ headers: { authorization: `Bearer ${token}` } }),
    null,
  )
})

test('Lean framing handles byte splits, coalesced messages, and UTF-8 byte lengths', () => {
  const messages = [],
    input = [
      { jsonrpc: '2.0', id: 1, result: '∀ n, α ≤ β 🙂' },
      { method: 'diagnostics', params: { uri: 'file:///workspace/Main.lean' } },
    ]
  const bytes = Buffer.from(input.map(frame).join(''))
  const parser = new LspFrames((message) => messages.push(message))
  for (let i = 0; i < bytes.length; i++) parser.push(bytes.subarray(i, i + 1))
  assert.deepEqual(messages, input)
  const joined = []
  new LspFrames((message) => joined.push(message)).push(bytes)
  assert.deepEqual(joined, input)
  assert.throws(
    () =>
      new LspFrames(() => {}, 8).push(Buffer.from('Content-Length: 9\r\n\r\n')),
    /length/,
  )
  assert.throws(
    () => new LspFrames(() => {}).push(Buffer.from('x'.repeat(8193))),
    /header/,
  )
  assert.throws(() =>
    new LspFrames(() => {}).push(Buffer.from('Content-Length: 1\r\n\r\nx')),
  )
})

test('LSP URI checks cover nested locations, targetUri, encoded traversal, roots, and secrets', () => {
  const good = {
    params: {
      rootUri: 'file:///workspace',
      rootPath: '/workspace',
      textDocument: { uri: 'file:///workspace/Main.lean' },
      locations: [
        { targetUri: 'file:///workspace/.lake/packages/mathlib/Mathlib.lean' },
      ],
    },
  }
  assert.equal(validateClientUris(good), good)
  for (const uri of [
    'file:///etc/passwd',
    'file://otherhost/workspace/Main.lean',
    'file:///workspace-other/Main.lean',
    'file:///workspace/%2f..%2fsecret',
    'file:///workspace/.git/config',
    'file:///workspace/.lemex/auth.json',
    'file:///workspace/.env.local',
    'file:///workspace/.ssh/id_rsa',
  ]) {
    assert.throws(
      () => validateClientUris({ result: [{ targetUri: uri }] }),
      undefined,
      uri,
    )
  }
  assert.throws(() => validateClientUris({ params: { rootPath: '/etc' } }))
})

test('Lemex RPC resolves concurrent responses and rejects pending calls when the process exits', async () => {
  const child = childProcess(),
    rpc = new AgentRpc(child)
  const one = rpc.call('one', {}, 1000),
    two = rpc.call('two', {}, 1000)
  const outgoing = child.requests.map((line) => JSON.parse(line))
  child.stdout.write(
    JSON.stringify({ id: outgoing[1].id, result: 'second' }) +
      '\n' +
      JSON.stringify({ id: outgoing[0].id, result: 'first' }) +
      '\n',
  )
  assert.deepEqual(await Promise.all([one, two]), ['first', 'second'])
  const pending = rpc.call('pending', {}, 1000)
  const rejection = assert.rejects(pending, /exited/)
  child.kill()
  await rejection
  assert.equal(rpc.pending.size, 0)
})

test('proof checks preserve statements and context and reject unfinished or trusted-kernel bypasses', () => {
  const before = 'theorem target (n : Nat) : n + 0 = n := by\n  sorry\n'
  const good = before.replace('sorry', 'simp')
  assert.deepEqual(
    proofRisks([{ path: 'Main.lean', before, after: good }], 'repair'),
    [],
  )
  for (const after of [
    good.replace('n + 0 = n', 'n = 0'),
    good + '\naxiom forged : False\n',
    good + '\nexample : True := by sorry\n',
    good + '\nset_option debug.skipKernelTC true\n',
    good + '\nset_option warn.sorry false\n',
    good + '\nunsafe def bad := 1\n',
    'variable (extra : False)\n' + good,
  ]) {
    assert.ok(
      proofRisks([{ path: 'Main.lean', before, after }], 'repair').length,
      after,
    )
  }
  for (const filename of [
    'lakefile.lean',
    'lakefile.toml',
    'lean-toolchain',
    'lake-manifest.json',
    '.lake/packages/mathlib/Mathlib.lean',
  ])
    assert.ok(
      proofRisks([{ path: filename, before: '', after: good }], 'prove').length,
    )
  assert.ok(
    proofRisks([{ path: 'Main.lean', before: good, after: null }], 'repair')
      .length,
  )
})

test('proof checks distinguish theorems with the same short name in different namespaces', () => {
  const before =
    'namespace A\ntheorem same : True := by trivial\nend A\nnamespace B\ntheorem same : True := by trivial\nend B\n'
  const after = before.replace('theorem same : True', 'theorem same : False')
  assert.ok(
    proofRisks([{ path: 'Main.lean', before, after }], 'repair').some(
      (problem) => problem.includes('statement'),
    ),
  )
})

test('comments and strings mentioning sorry, axioms, and trust settings do not cause false alarms', () => {
  const before =
    '#check "axiom sorry implemented_by debug.skipKernelTC"\ntheorem target : True := by trivial\n'
  const after =
    before +
    '/- axiom fake : False /- sorry -/ debug.skipKernelTC -/\n-- unsafe admit\n'
  assert.deepEqual(
    proofRisks([{ path: 'Main.lean', before, after }], 'prove'),
    [],
  )
  assert.equal(maskLean(after).includes('debug.skipKernelTC'), false)
  assert.deepEqual(
    declarationNames(
      'namespace A\nsection\ntheorem α : True := by trivial\nend\nend A\n',
    ),
    ['A.α'],
  )
})

test('repair preserves definitions and notation while allowing legitimate proof body changes', () => {
  const before =
    'def specification : Prop := True\nnotation "Target" => specification\ntheorem target : Target := by\n  sorry\n'
  const repaired = before.replace('sorry', 'trivial')
  assert.deepEqual(
    proofRisks([{ path: 'Main.lean', before, after: repaired }], 'repair'),
    [],
  )
  for (const after of [
    repaired.replace(
      'specification : Prop := True',
      'specification : Prop := False',
    ),
    repaired.replace('"Target" => specification', '"Target" => True'),
  ]) {
    assert.ok(
      proofRisks([{ path: 'Main.lean', before, after }], 'repair').some(
        (problem) => problem.includes('outside'),
      ),
    )
  }
  assert.deepEqual(
    proofRisks(
      [
        {
          path: 'Main.lean',
          before,
          after: repaired.replace(
            '"Target" => specification',
            '"Target" => True',
          ),
        },
      ],
      'formalize',
    ),
    [],
  )
})

test('proof review rejects executable tactics and commands hidden in indented proof spans', () => {
  const before = 'theorem target : True := by\n  sorry\n'
  for (const body of [
    'run_tac IO.println "injected"',
    'trivial\n  set_option maxRecDepth 0',
    'trivial\n  macro_rules | `(broken) => `(True)',
    'trivial\n  local notation "Target" => False',
    'trivial\n  #eval 1',
  ]) {
    assert.ok(
      proofRisks(
        [{ path: 'Main.lean', before, after: before.replace('sorry', body) }],
        'repair',
      ).length,
      body,
    )
  }
  assert.ok(
    proofRisks(
      [
        {
          path: 'New.lean',
          before: null,
          after: 'run_cmd IO.println "forged audit"\n',
        },
      ],
      'formalize',
    ).length,
  )
})

const auditEnv = {
  LEAN_SYSROOT: '/opt/lean-toolchains/leanprover--lean4---v4.34.1',
  LEAN_PATH:
    '/workspace/.lake/build/lib/lean:/opt/lean-toolchains/leanprover--lean4---v4.34.1/lib/lean',
  LEAN_SRC_PATH: '/workspace',
}

test('candidate verification resolves the trusted environment before build and audits readonly with a fresh home', async (t) => {
  const root = await temp(t),
    calls = [],
    runtime = {
      async run(root, args, options) {
        calls.push({ root, args, options })
        if (args[1] === 'env')
          return { code: 0, stdout: JSON.stringify(auditEnv), stderr: '' }
        return args.includes('build')
          ? { code: 0, stdout: '', stderr: '' }
          : {
              code: 0,
              stdout: JSON.stringify({
                compiled: true,
                complete: true,
                kernelChecked: true,
                files: [{ path: 'Proofs/Selected.lean' }],
                axioms: [],
                errors: [],
                warnings: [],
              }),
              stderr: '',
            }
      },
    }
  const result = await verifyCandidate(
    runtime,
    root,
    [
      {
        path: 'Proofs/Selected.lean',
        before: '',
        after: 'theorem selected : True := by trivial\n',
      },
    ],
    'prove',
    () => {},
  )
  assert.equal(result.complete, true)
  assert.deepEqual(calls[1].args, ['lake', 'build'])
  assert.deepEqual(JSON.parse(calls[2].args.at(-1)), [
    { path: 'Proofs/Selected.lean', names: ['selected'] },
  ])
  assert.deepEqual(calls[2].args.slice(0, 3), ['python3', '-I', '-c'])
  assert.ok(calls.every((call) => call.options.network === 'none'))
  for (const key of ['readOnlyWorkspace', 'readOnlyHome', 'freshHome'])
    assert.equal(calls[2].options[key], true)
  assert.deepEqual(calls[2].options.env, auditEnv)
})

test('candidate verification fails closed when the independent audit process fails', async (t) => {
  const runtime = {
    async run(_root, args) {
      if (args[1] === 'env')
        return { code: 0, stdout: JSON.stringify(auditEnv), stderr: '' }
      return args.includes('build')
        ? { code: 0, stdout: '', stderr: '' }
        : {
            code: 1,
            stdout:
              '{"compiled":true,"complete":true,"kernelChecked":true,"files":[],"axioms":[]}',
            stderr: 'audit process failed',
          }
    },
  }
  const result = await verifyCandidate(
    runtime,
    await temp(t),
    [
      {
        path: 'Main.lean',
        before: '',
        after: 'theorem selected : True := by trivial\n',
      },
    ],
    'prove',
    () => {},
  )
  assert.equal(result.complete, false)
  assert.equal(result.compiled, false)
})

test('a candidate build that writes source or lake configuration cannot reach the audit', async (t) => {
  const root = await temp(t),
    calls = [],
    runtime = {
      async run(_root, args) {
        calls.push(args)
        if (args[1] === 'env')
          return { code: 0, stdout: JSON.stringify(auditEnv), stderr: '' }
        await fs.writeFile(path.join(root, 'lakefile.lean'), '#eval "forged"')
        return { code: 0, stdout: '', stderr: '' }
      },
    }
  const result = await verifyCandidate(
    runtime,
    root,
    [
      {
        path: 'Main.lean',
        before: '',
        after: 'theorem selected : True := by trivial\n',
      },
    ],
    'prove',
    () => {},
  )
  assert.equal(result.complete, false)
  assert.match(result.errors[0], /source or configuration/)
  assert.equal(calls.length, 2)
})

test('activity events persist, replay after a cursor, and mark interrupted jobs on restart', async (t) => {
  const directory = await temp(t)
  let store = new EventStore(directory)
  t.after(() => store.close())
  const active = store.create('alice', { projectId: 'one', kind: 'agent' })
  const completed = store.create('alice', { projectId: 'one', kind: 'check' })
  store.update(active.id, { status: 'running' })
  store.append(active.id, 'message', 'Hello α', 'message')
  store.update(completed.id, { status: 'completed' })
  assert.throws(() => store.get(active.id, 'bob'), { status: 404 })
  assert.deepEqual(store.list('bob', 'one'), [])
  assert.equal(store.list('alice', 'one', 'check').length, 1)
  const prior = store.events(active.id),
    cursor = prior[0].seq
  assert.deepEqual(
    store.events(active.id, cursor).map((event) => event.seq),
    prior.slice(1).map((event) => event.seq),
  )
  store.close()
  store = new EventStore(directory)
  assert.equal(store.get(active.id, 'alice').status, 'interrupted')
  assert.equal(store.get(active.id, 'alice').message, 'Hello α')
  assert.equal(store.get(completed.id, 'alice').status, 'completed')
  assert.equal(store.events(active.id).at(-1).data.status, 'interrupted')
})

test('per-project activity remains visible after many newer jobs in other projects', async (t) => {
  const events = new EventStore(await temp(t))
  t.after(() => events.close())
  const active = events.create('alice', {
    projectId: 'important',
    kind: 'agent',
  })
  events.update(active.id, { status: 'running' })
  for (let i = 0; i < 105; i++)
    events.create('alice', { projectId: 'other', kind: 'check' })
  assert.equal(
    events
      .list('alice', 'important')
      .some((job) => job.id === active.id && job.status === 'running'),
    true,
  )
})

test('Check validates the selected Lean file even if it is outside default Lake build targets', async (t) => {
  const directory = await temp(t),
    events = new EventStore(directory)
  t.after(() => events.close())
  const calls = [],
    reads = []
  const jobs = new JobManager({
    events,
    runtime: {
      async run(root, args, options) {
        calls.push({ root, args, options })
        return {
          code: args.includes('Selected.lean') ? 1 : 0,
          stdout: '',
          stderr: args.includes('Selected.lean') ? 'unsolved goals' : '',
        }
      },
    },
    workspaces: {
      get: (id, owner) => ({
        id,
        owner,
        root: '/project',
        status: 'ready',
        repairedConfiguration: true,
      }),
      readFile: async (id, owner, file) => {
        reads.push({ id, owner, file })
        return { content: '' }
      },
    },
  })
  const job = jobs.check('alice', 'one', 'Selected.lean')
  const result = await finishedJob(events, job.id)
  assert.equal(result.status, 'failed')
  assert.deepEqual(reads, [
    { id: 'one', owner: 'alice', file: 'Selected.lean' },
  ])
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['lake', 'build'],
      ['lake', 'env', 'lean', '--json', '-Dwarn.sorry=true', 'Selected.lean'],
    ],
  )
  assert.ok(calls.every((call) => call.options.network === 'none'))
  assert.ok(
    calls.every(
      (call) => call.options.readOnlyWorkspace && call.options.writeLakeCache,
    ),
  )
})

test('stopping a Lean check is owner-scoped, cancels its worker and skips subsequent file evaluation', async (t) => {
  const { request, runtime, workspaces, project } = await fixture(t)
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  runtime.run = async (root, args, options) => {
    assert.equal(root, workspaces.get(project.id, 'owner').root)
    assert.deepEqual(args, ['lake', 'build'])
    started()
    return new Promise((resolve) => {
      AbortSignal.any([
        options.signal,
        AbortSignal.timeout(3000),
      ]).addEventListener(
        'abort',
        () => resolve({ code: 137, cancelled: true, stdout: '', stderr: '' }),
        { once: true },
      )
    })
  }
  const checked = await request(`/api/projects/${project.id}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'Main.lean' }),
  })
  assert.equal(checked.status, 202)
  const job = await checked.json()
  await ready
  const forbidden = await request(
    `/api/jobs/${job.id}/stop`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    'collaborator-test-token',
  )
  assert.equal(forbidden.status, 404)
  const stopped = await request(`/api/jobs/${job.id}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(stopped.status, 200)
  assert.equal((await stopped.json()).status, 'cancelled')
  assert.equal(
    (
      await (
        await request(`/api/jobs/${job.id}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).json()
    ).status,
    'cancelled',
  )
})

test('a timed-out Lean check reports how to recover from blocking evaluation', async (t) => {
  const events = new EventStore(await temp(t))
  t.after(() => events.close())
  const jobs = new JobManager({
    events,
    workspaces: { get: () => ({ root: '/fixture', status: 'ready' }) },
    runtime: {
      run: async () => ({ code: 137, timedOut: true, stdout: '', stderr: '' }),
    },
  })
  const job = jobs.check('alice', 'project')
  const result = await finishedJob(events, job.id)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /time limit.*last module/)
})

test('settings remain private per user, persist, and validate tool choices and instruction size', async (t) => {
  const directory = await temp(t),
    settings = new Settings(directory)
  const alice = {
    extraInstructions: 'Keep theorem statements unchanged.',
    tools: { lean: true, lean_explore: false, exa: false },
  }
  await settings.save('alice', alice)
  assert.deepEqual(await new Settings(directory).get('alice'), {
    ...alice,
    tools: { ...alice.tools, lean_probe: true },
    showReasoning: true,
  })
  assert.equal((await settings.get('bob')).extraInstructions, '')
  for (const input of [
    null,
    { extraInstructions: 1, tools: alice.tools },
    { extraInstructions: 'x'.repeat(20001), tools: alice.tools },
    { extraInstructions: '', tools: { ...alice.tools, lean: 'true' } },
    { extraInstructions: '' },
  ])
    await assert.rejects(settings.save('alice', input), { status: 400 })
  await assert.rejects(settings.get('../alice'))
  assert.deepEqual(await settings.get('alice'), {
    ...alice,
    tools: { ...alice.tools, lean_probe: true },
    showReasoning: true,
  })
})

test('concurrent settings saves each complete and leave one valid persisted configuration', async (t) => {
  const directory = await temp(t),
    settings = new Settings(directory)
  const choices = [
    {
      extraInstructions: 'One browser tab',
      tools: { lean: true, lean_explore: false, exa: true },
    },
    {
      extraInstructions: 'Another browser tab',
      tools: { lean: false, lean_explore: true, exa: false },
    },
  ]
  const results = await Promise.allSettled(
    choices.map((choice) => settings.save('alice', choice)),
  )
  assert.ok(
    results.every((result) => result.status === 'fulfilled'),
    JSON.stringify(
      results.map((result) => ({
        status: result.status,
        error: result.reason?.message,
      })),
    ),
  )
  const persisted = await settings.get('alice')
  assert.ok(
    choices.some(
      (choice) =>
        choice.extraInstructions === persisted.extraInstructions &&
        Object.entries(choice.tools).every(
          ([key, value]) => persisted.tools[key] === value,
        ) &&
        persisted.showReasoning === true,
    ),
  )
})

test('HTTP authentication and login keep collaborator tokens and provider credentials out of responses', async (t) => {
  const { request, token, providerSecret } = await fixture(t)
  assert.equal((await request('/api/session', {}, null)).status, 401)
  assert.equal((await request('/api/projects', {}, null)).status, 401)
  const login = await request(
    '/api/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
    null,
  )
  assert.equal(login.status, 200)
  const body = await login.text()
  assert.deepEqual(JSON.parse(body), { user: { id: 'owner', name: 'Owner' } })
  assert.ok(!body.includes(token) && !body.includes('tokenHash'))
  const cookie = login.headers.get('set-cookie')
  assert.ok(
    cookie.includes('HttpOnly') &&
      cookie.includes('SameSite=Strict') &&
      cookie.includes('Path=/'),
  )
  const session = await request(
    '/api/session',
    { headers: { Cookie: cookie.split(';')[0] } },
    null,
  )
  assert.equal(session.status, 200)
  const sessionBody = await session.text()
  assert.ok(
    !sessionBody.includes(token) &&
      !sessionBody.includes(providerSecret) &&
      !sessionBody.includes('tokenHash'),
  )
})

test('HTTP rejects wrong origins and protects projects, files, jobs, and event streams by owner', async (t) => {
  const { request, project, otherToken, events, workspaces } = await fixture(t)
  const response = await request('/api/projects', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.test',
    },
    body: JSON.stringify({ preset: 'lean' }),
  })
  assert.equal(response.status, 403)
  assert.equal(workspaces.list('owner').length, 1)
  const job = events.create('owner', { projectId: project.id, kind: 'agent' })
  for (const endpoint of [
    `/api/projects/${project.id}`,
    `/api/projects/${project.id}/files`,
    `/api/projects/${project.id}/file?path=Main.lean`,
    `/api/jobs/${job.id}`,
    `/api/runs/${job.id}/events`,
  ])
    assert.equal(
      (await request(endpoint, {}, otherToken)).status,
      404,
      endpoint,
    )
  assert.deepEqual(
    await (await request('/api/projects', {}, otherToken)).json(),
    [],
  )
  assert.equal(
    (
      await request(`/api/projects/${project.id}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    409,
  )
})

test('active Lean checks block project configuration, preparation, and Git mutations until they finish', async (t) => {
  const { request, project, events, workspaces, runtime } = await fixture(t)
  const configs = new Map()
  for (const filename of [
    'lean-toolchain',
    'lakefile.toml',
    'lake-manifest.json',
  ])
    configs.set(
      filename,
      await workspaces.readFile(project.id, 'owner', filename),
    )
  configs.set('lakefile.lean', {
    content: 'import Lake\nopen Lake DSL\npackage guarded_project\n',
    hash: null,
  })
  const check = events.create('owner', { kind: 'check', projectId: project.id })
  const callsBefore = runtime.calls.length,
    spawnedBefore = runtime.spawned.length
  const json = (body) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  for (const status of [
    'queued',
    'starting',
    'running',
    'stopping',
    'verifying',
    'preparing',
  ]) {
    events.update(check.id, { status })
    for (const [filename, source] of configs) {
      const response = await request(
        `/api/projects/${project.id}/file?path=${filename}`,
        {
          method: 'PUT',
          ...json({ content: source.content, expectedHash: source.hash }),
        },
      )
      assert.equal(
        response.status,
        409,
        `Configuration save ${filename} during ${status}`,
      )
    }
    const preparation = await request(`/api/projects/${project.id}/prepare`, {
      method: 'POST',
      ...json({}),
    })
    assert.equal(preparation.status, 409, `Preparation during ${status}`)
    for (const body of [
      { action: 'branch', name: 'guarded-check' },
      { action: 'commit', message: 'Guarded check commit' },
    ]) {
      const mutation = await request(`/api/projects/${project.id}/git`, {
        method: 'POST',
        ...json(body),
      })
      assert.equal(mutation.status, 409, `Git ${body.action} during ${status}`)
    }
  }
  assert.equal(
    runtime.calls.length,
    callsBefore,
    'Rejected mutations must not launch Lake or Git',
  )
  assert.equal(runtime.spawned.length, spawnedBefore)
  for (const [filename, source] of configs)
    if (source.hash !== null)
      assert.deepEqual(
        await workspaces.readFile(project.id, 'owner', filename),
        source,
      )
  await assert.rejects(
    workspaces.readFile(project.id, 'owner', 'lakefile.lean'),
    { status: 404 },
  )

  events.update(check.id, { status: 'completed' })
  events.create('bob', { kind: 'check', projectId: project.id })
  events.create('owner', { kind: 'check', projectId: 'a-different-project' })
  const source = configs.get('lean-toolchain')
  const saved = await request(
    `/api/projects/${project.id}/file?path=lean-toolchain`,
    {
      method: 'PUT',
      ...json({ content: source.content, expectedHash: source.hash }),
    },
  )
  assert.equal(
    saved.status,
    200,
    'Finished checks and active jobs in another owner/project must not block this project',
  )
  const branch = await request(`/api/projects/${project.id}/git`, {
    method: 'POST',
    ...json({ action: 'branch', name: 'after-check' }),
  })
  assert.equal(branch.status, 200)
  const prepared = await request(`/api/projects/${project.id}/prepare`, {
    method: 'POST',
    ...json({}),
  })
  assert.equal(prepared.status, 200)
  await workspaces.jobs.get(project.id)
  assert.equal(workspaces.get(project.id, 'owner').status, 'ready')
  assert(runtime.calls.length > callsBefore)
})

test('WebSocket authentication, origin, and project ownership fail before any Lean worker starts', async (t) => {
  const { url, token, otherToken, project, runtime } = await fixture(t)
  const endpoint = url.replace('http:', 'ws:') + '/websocket/' + project.id
  assert.equal(await rejectedSocket(endpoint, {}), 401)
  assert.equal(
    await rejectedSocket(endpoint, {
      Authorization: `Bearer ${token}`,
      Origin: 'https://evil.test',
    }),
    403,
  )
  assert.equal(
    await rejectedSocket(endpoint, { Authorization: `Bearer ${otherToken}` }),
    404,
  )
  assert.equal(runtime.spawned.length, 0)
})

test('terminal authentication, origin, ownership and preparation checks reject before starting a worker', async (t) => {
  const { url, token, otherToken, project, runtime, workspaces } =
    await fixture(t)
  const endpoint =
    url.replace('http:', 'ws:') + '/websocket/terminal/' + project.id
  assert.equal(await rejectedSocket(endpoint, {}), 401)
  assert.equal(
    await rejectedSocket(endpoint, {
      Authorization: `Bearer ${token}`,
      Origin: 'https://evil.test',
    }),
    403,
  )
  assert.equal(
    await rejectedSocket(endpoint, { Authorization: `Bearer ${otherToken}` }),
    404,
  )
  const saved = workspaces.get(project.id, 'owner')
  saved.status = 'preparing'
  workspaces.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(saved), project.id)
  assert.equal(
    await rejectedSocket(endpoint, { Authorization: `Bearer ${token}` }),
    409,
  )
  assert.equal(runtime.spawned.length, 0)
})

async function connectTerminal(t, f) {
  const ws = new WebSocket(
    f.url.replace('http:', 'ws:') + '/websocket/terminal/' + f.project.id,
    {
      headers: { Authorization: `Bearer ${f.token}` },
    },
  )
  t.after(() => ws.terminate())
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

test('terminal relays bytes, accepts bounded input and resize, and stops its worker on disconnect', async (t) => {
  const f = await fixture(t)
  const ws = await connectTerminal(t, f)
  const child = f.runtime.spawned[0]
  assert.equal(child.root, f.workspaces.get(f.project.id, 'owner').root)
  assert.equal(child.args[0], 'python3')
  assert.equal(child.options.network, 'bridge')
  assert.equal(child.options.freshHome, true)
  assert.equal(child.options.cleanHome, true)
  assert(!Object.values(child.options.env).includes(f.providerSecret))
  const output = new Promise((resolve) =>
    ws.once('message', (data, binary) => resolve({ data, binary })),
  )
  const bytes = Buffer.from('\u001b[32mLean α\u001b[0m\r\n')
  child.stdout.write(bytes)
  assert.deepEqual(await output, { data: bytes, binary: true })
  const received = new Promise((resolve) => child.stdin.once('data', resolve))
  ws.send(
    JSON.stringify({
      type: 'input',
      data: 'lake build\r',
      root: '/etc',
      env: { SECRET: 'unused' },
    }),
  )
  assert.deepEqual(JSON.parse(String(await received)), {
    type: 'input',
    data: 'lake build\r',
  })
  const resized = new Promise((resolve) => child.stdin.once('data', resolve))
  ws.send(JSON.stringify({ type: 'resize', rows: 24, cols: 80 }))
  assert.deepEqual(JSON.parse(String(await resized)), {
    type: 'resize',
    rows: 24,
    cols: 80,
  })
  const killed = new Promise((resolve) => child.once('close', resolve))
  ws.close()
  await killed
  assert.equal(child.killed, true)
})

test('terminal output pauses until the browser acknowledges bytes', async (t) => {
  const f = await fixture(t)
  const ws = await connectTerminal(t, f)
  const child = f.runtime.spawned[0]
  const output = new Promise((resolve) => ws.once('message', resolve))
  child.stdout.write(Buffer.alloc(256 * 1024, 65))
  await output
  assert.equal(child.stdout.isPaused(), true)
  const resumed = new Promise((resolve) => child.stdout.once('resume', resolve))
  ws.send(JSON.stringify({ type: 'ack', bytes: 256 * 1024 }))
  await resumed
  assert.equal(child.stdout.isPaused(), false)
  assert.equal(
    child.requests.length,
    0,
    'acknowledgements must not reach the shell',
  )
})

test('closing a terminal reconciles configuration and exposes the existing setup recovery flow', async (t) => {
  const f = await fixture(t)
  await connectTerminal(t, f)
  const root = f.workspaces.get(f.project.id, 'owner').root
  await fs.appendFile(path.join(root, 'lean-toolchain'), '\n')
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }
  const stop = await f.request(
    `/api/projects/${f.project.id}/terminal/stop`,
    options,
  )
  assert.equal(stop.status, 200)
  assert.deepEqual(await stop.json(), { stopped: true })
  assert.equal(f.runtime.spawned[0].killed, true)
  const project = await (
    await f.request(`/api/projects/${f.project.id}`)
  ).json()
  assert.equal(project.status, 'error')
  assert.equal(project.needsPreparation, true)
  assert.match(project.error, /configuration changed.*Retry setup/)
  const prepare = await f.request(
    `/api/projects/${f.project.id}/prepare`,
    options,
  )
  assert.equal(prepare.status, 200)
  await f.workspaces.jobs.get(f.project.id)
  assert.equal(f.workspaces.get(f.project.id, 'owner').status, 'ready')
})

test('terminal stop authenticates and scopes ownership; ordinary source edits do not invalidate setup', async (t) => {
  const f = await fixture(t)
  await connectTerminal(t, f)
  const root = f.workspaces.get(f.project.id, 'owner').root
  await fs.appendFile(
    path.join(root, 'Main.lean'),
    '\n-- terminal source edit\n',
  )
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }
  const endpoint = `/api/projects/${f.project.id}/terminal/stop`
  assert.equal((await f.request(endpoint, options, '')).status, 401)
  assert.equal((await f.request(endpoint, options, f.otherToken)).status, 404)
  assert.equal(f.runtime.spawned[0].killed, false)
  assert.equal((await f.request(endpoint, options)).status, 200)
  assert.equal(f.workspaces.get(f.project.id, 'owner').status, 'ready')
})

test('terminal stop waits for worker cleanup before configuration reconciliation and preparation', async (t) => {
  const f = await fixture(t)
  const spawn = f.runtime.spawn.bind(f.runtime)
  let finishCleanup
  f.runtime.spawn = (...args) => {
    const child = spawn(...args)
    child.workerStopped = new Promise((resolve) => {
      finishCleanup = resolve
    })
    return child
  }
  await connectTerminal(t, f)
  const root = f.workspaces.get(f.project.id, 'owner').root
  await fs.appendFile(path.join(root, 'lean-toolchain'), '\n')
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }
  let stopped = false
  const stop = f
    .request(`/api/projects/${f.project.id}/terminal/stop`, options)
    .then((response) => {
      stopped = true
      return response
    })
  await new Promise((resolve) => f.runtime.spawned[0].once('close', resolve))
  assert.equal(stopped, false)
  assert.equal(f.workspaces.get(f.project.id, 'owner').status, 'ready')
  finishCleanup()
  assert.equal((await stop).status, 200)
  assert.equal(f.workspaces.get(f.project.id, 'owner').needsPreparation, true)
})

test('a disconnected terminal holds its project guard and capacity until worker cleanup finishes', async (t) => {
  const f = await fixture(t)
  let finishCleanup
  const spawn = f.runtime.spawn.bind(f.runtime)
  f.runtime.spawn = (...args) => {
    const child = spawn(...args)
    child.workerStopped = new Promise((resolve) => {
      finishCleanup = resolve
    })
    return child
  }
  const ws = await connectTerminal(t, f)
  const stopped = new Promise((resolve) =>
    f.runtime.spawned[0].once('close', resolve),
  )
  ws.close()
  await stopped
  const endpoint =
    f.url.replace('http:', 'ws:') + '/websocket/terminal/' + f.project.id
  assert.equal(
    await rejectedSocket(endpoint, { Authorization: `Bearer ${f.token}` }),
    429,
  )
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }
  assert.equal(
    (await f.request(`/api/projects/${f.project.id}/prepare`, options)).status,
    409,
  )
  finishCleanup()
  await new Promise((resolve) => setImmediate(resolve))
  const next = await connectTerminal(t, f)
  assert.equal(next.readyState, WebSocket.OPEN)
  finishCleanup()
})

for (const message of [
  { type: 'resize', rows: 0, cols: 80 },
  { type: 'resize', rows: 20, cols: 1.5 },
  { type: 'input', data: 'a'.repeat(16 * 1024 + 1) },
  { type: 'input', data: 3 },
  { type: 'ack', bytes: 1 },
  { type: 'exec', command: ['sh'] },
  null,
]) {
  test(`invalid terminal ${message?.type || 'message'} stops the worker before forwarding input (${JSON.stringify(message).slice(0, 90)})`, async (t) => {
    const f = await fixture(t)
    const ws = await connectTerminal(t, f)
    const closed = new Promise((resolve) => ws.once('close', resolve))
    ws.send(JSON.stringify(message))
    assert.equal(await closed, 1008)
    assert.equal(f.runtime.spawned[0].requests.length, 0)
    assert.equal(f.runtime.spawned[0].killed, true)
  })
}

test('terminal guards capacity, preparation, Git and Trash, and stop-all cleans it up', async (t) => {
  const json = (body) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const f = await fixture(t)
  const ws = await connectTerminal(t, f)
  const endpoint =
    f.url.replace('http:', 'ws:') + '/websocket/terminal/' + f.project.id
  assert.equal(
    await rejectedSocket(endpoint, { Authorization: `Bearer ${f.token}` }),
    429,
  )
  for (const [route, body] of [
    ['prepare', {}],
    ['git', { action: 'branch', name: 'test' }],
    ['trash', {}],
    [
      'upload',
      {
        files: [
          { path: 'extra.lean', content: 'example : True := by trivial' },
        ],
      },
    ],
  ]) {
    const response = await f.request(`/api/projects/${f.project.id}/${route}`, {
      method: 'POST',
      ...json(body),
    })
    assert.equal(response.status, 409, route)
    assert.match((await response.json()).error, /Close the project terminal/)
  }
  f.runtime.stopProject = async (root) => {
    for (const child of f.runtime.spawned) if (child.root === root) child.kill()
  }
  const closed = new Promise((resolve) => ws.once('close', resolve))
  const response = await f.request(`/api/projects/${f.project.id}/trash`, {
    method: 'POST',
    ...json({ stopActive: true }),
  })
  assert.equal(response.status, 200)
  await closed
  assert.equal(f.runtime.spawned[0].killed, true)
})

test('repaired project LSP preserves source isolation and permits only Lake cache writes', async (t) => {
  const { url, token, project, runtime, workspaces } = await fixture(t)
  const saved = workspaces.get(project.id, 'owner')
  saved.repairedConfiguration = true
  workspaces.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(saved), project.id)
  const ws = new WebSocket(
    url.replace('http:', 'ws:') + '/websocket/' + project.id,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  t.after(() => ws.terminate())
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const child = runtime.spawned[0]
  assert.deepEqual(child.args, ['lake', 'serve', '--'])
  assert.equal(child.options.network, 'none')
  assert.equal(child.options.readOnlyWorkspace, true)
  assert.equal(child.options.writeLakeCache, true)
})

test('authorized WebSocket relays Lean frames and closes on forbidden client file URIs', async (t) => {
  const { url, token, project, runtime } = await fixture(t)
  const ws = new WebSocket(
    url.replace('http:', 'ws:') + '/websocket/' + project.id,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  t.after(() => ws.terminate())
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const child = runtime.spawned[0]
  assert.deepEqual(child.args, ['lake', 'serve', '--'])
  assert.equal(child.options.network, 'none')
  const reply = new Promise((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data))),
  )
  child.stdout.write(frame({ id: 1, result: 'Lean α' }))
  assert.deepEqual(await reply, { id: 1, result: 'Lean α' })
  const closed = new Promise((resolve) =>
    ws.once('close', (code) => resolve(code)),
  )
  ws.send(
    JSON.stringify({
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: 'file:///etc/passwd', text: 'secret' } },
    }),
  )
  assert.equal(await closed, 1008)
  assert.equal(child.requests.length, 0)
})

test('configuration saves close only that project editor and expose setup retry before new runs', async (t) => {
  const { url, token, project, runtime, workspaces, request } = await fixture(t)
  const ws = new WebSocket(
    url.replace('http:', 'ws:') + '/websocket/' + project.id,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  t.after(() => ws.terminate())
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const closed = new Promise((resolve) => ws.once('close', resolve))
  const workerClosed = new Promise((resolve) =>
    runtime.spawned[0].once('close', resolve),
  )
  const original = await workspaces.readFile(
    project.id,
    'owner',
    'lakefile.toml',
  )
  const response = await request(
    `/api/projects/${project.id}/file?path=lakefile.toml`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: original.content + '\n# Updated configuration\n',
        expectedHash: original.hash,
      }),
    },
  )
  assert.equal(response.status, 200)
  assert.equal((await response.json()).requiresPreparation, true)
  assert.equal(await closed, 1012)
  assert.equal(workspaces.get(project.id, 'owner').status, 'error')
  await assert.rejects(
    workspaces.snapshot(project.id, 'owner', 'stale-config'),
    { status: 409 },
  )
  await workerClosed
  assert(runtime.spawned[0].killed)
  const retry = await request(`/api/projects/${project.id}/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(retry.status, 200)
  await workspaces.jobs.get(project.id)
  assert.equal(workspaces.get(project.id, 'owner').status, 'ready')
})

test('a server without a provider does not install automatic setup repair', async (t) => {
  const dataDir = await temp(t),
    runtime = new FakeRuntime()
  const studio = await createStudio({
    dataDir,
    runtime,
    config: {
      provider: {},
      defaultModel: 'test',
      models: [],
      lemex: {},
      redact: String,
    },
    titleGenerator: async () => null,
  })
  t.after(() => studio.close())
  assert.equal(studio.workspaces.setupRepair, undefined)
})

test('startup migrates existing aliased project directories and retains missing projects as errors', async (t) => {
  const base = await temp(t),
    real = path.join(base, 'data'),
    alias = path.join(base, 'alias')
  await fs.mkdir(real)
  await fs.symlink(real, alias)
  const first = await createStudio({
    dataDir: real,
    runtime: new FakeRuntime(),
    config: {
      provider: {},
      models: [],
      defaultModel: 'fixture',
      lemex: {},
      redact: String,
    },
    titleGenerator: async () => null,
  })
  const projects = []
  for (let i = 0; i < 4; i++) {
    const project = await first.workspaces.create('owner', { preset: 'lean' })
    await first.workspaces.jobs.get(project.id)
    const stored = first.workspaces.get(project.id, 'owner')
    stored.root = path.join(alias, 'projects', project.id)
    if (i >= 2) {
      stored.repository = 'https://github.com/fixture/project.git'
      stored.subdirectory = 'lean'
      stored.status = 'error'
      stored.imported = false
      if (i === 3) {
        await fs.mkdir(path.join(project.root, 'lean'))
        stored.root = path.join(stored.root, 'lean')
      }
    }
    first.workspaces.db
      .prepare('UPDATE projects SET data=? WHERE id=?')
      .run(JSON.stringify(stored), project.id)
    projects.push(project)
  }
  await fs.rm(projects[1].root, { recursive: true })
  await first.close()
  const restarted = await createStudio({
    dataDir: alias,
    runtime: new FakeRuntime(),
    config: {
      provider: {},
      models: [],
      defaultModel: 'fixture',
      lemex: {},
      redact: String,
    },
    titleGenerator: async () => null,
  })
  t.after(() => restarted.close())
  const ready = restarted.workspaces.get(projects[0].id, 'owner')
  assert.equal(ready.root, path.join(real, 'projects', projects[0].id))
  assert.equal(ready.status, 'ready')
  const missing = restarted.workspaces.get(projects[1].id, 'owner')
  assert.equal(missing.status, 'error')
  assert.match(missing.error, /directory is missing/)
  assert.equal(
    restarted.workspaces.get(projects[2].id, 'owner').root,
    path.join(real, 'projects', projects[2].id),
  )
  assert.equal(
    restarted.workspaces.get(projects[3].id, 'owner').root,
    path.join(real, 'projects', projects[3].id, 'lean'),
  )
})

test('large Lean sources open and save over HTTP while stale hashes and oversized content remain rejected', async (t) => {
  const f = await fixture(t)
  const original =
    '-- ' + '\t'.repeat(5_400_000) + '\nexample : True := by trivial\n'
  await fs.writeFile(path.join(f.project.root, 'Large.lean'), original)
  const endpoint = `/api/projects/${f.project.id}/file?path=Large.lean`
  const opened = await f.request(endpoint)
  assert.equal(opened.status, 200)
  const source = await opened.json()
  assert.equal(hash(source.content), hash(original))
  const savedContent = original + '-- saved\n'
  const save = (content, expectedHash) =>
    f.request(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, expectedHash }),
    })
  const saved = await save(savedContent, source.hash)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.equal((await saved.json()).hash, hash(savedContent))
  const conflicted = await save(original, source.hash)
  assert.equal(conflicted.status, 409)
  assert.equal(
    hash(await fs.readFile(path.join(f.project.root, 'Large.lean'))),
    hash(savedContent),
  )
  const oversized = await save(
    'x'.repeat(8 * 1024 * 1024 + 1),
    hash(savedContent),
  )
  assert.equal(oversized.status, 413)
  assert.match((await oversized.json()).error, /8 MiB/)
  assert.equal(
    hash(await fs.readFile(path.join(f.project.root, 'Large.lean'))),
    hash(savedContent),
  )
  await fs.writeFile(
    path.join(f.project.root, 'Oversized.lean'),
    'x'.repeat(8 * 1024 * 1024 + 1),
  )
  const unreadable = await f.request(
    `/api/projects/${f.project.id}/file?path=Oversized.lean`,
  )
  assert.equal(unreadable.status, 413)
  assert.match((await unreadable.json()).error, /8 MiB/)
})

test('folder imports accept more than 20 MiB and retain the bounded 32 MiB source total', async (t) => {
  const f = await fixture(t)
  const large = '-- ' + 'a'.repeat(5_400_000) + '\n'
  const files = [
    { path: 'lean-toolchain', content: TOOLCHAIN + '\n' },
    { path: 'lakefile.toml', content: 'name = "large-import"\n' },
    ...Array.from({ length: 4 }, (_, index) => ({
      path: `Large${index}.lean`,
      content: large,
    })),
  ]
  const created = await f.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, autoRepair: false }),
  })
  assert.equal(created.status, 201, await created.clone().text())
  const project = await created.json()
  await f.workspaces.jobs.get(project.id)
  assert.equal(f.workspaces.get(project.id, 'owner').status, 'ready')
  for (let index = 0; index < 4; index++)
    assert.equal(
      (await f.workspaces.readFile(project.id, 'owner', `Large${index}.lean`))
        .hash,
      hash(large),
    )
  const overTotal = await f.request(`/api/projects/${f.project.id}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: Array.from({ length: 5 }, (_, index) => ({
        path: `Added${index}.lean`,
        content: 'a'.repeat(7_000_000),
      })),
    }),
  })
  assert.equal(overTotal.status, 413)
  assert.match((await overTotal.json()).error, /32 MiB/)
  assert.equal(
    (await f.workspaces.files(f.project.id, 'owner')).some((file) =>
      file.path.startsWith('Added'),
    ),
    false,
  )
})

test('Lean WebSocket relays large escaped source and rejects oversized decoded updates before reaching its worker', async (t) => {
  const { url, token, project, runtime, request } = await fixture(t)
  const ws = new WebSocket(
    url.replace('http:', 'ws:') + '/websocket/' + project.id,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  t.after(() => ws.terminate())
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const child = runtime.spawned[0]
  const text = '-- ' + '\t'.repeat(5_400_000) + '\n'
  const opened = {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: 'file:///workspace/Large.lean',
        languageId: 'lean4',
        version: 1,
        text,
      },
    },
  }
  // Escaping makes this frame larger than the previous 8 MiB WebSocket cap.
  assert(Buffer.byteLength(JSON.stringify(opened)) > 8 * 1024 * 1024)
  const received = new Promise((resolve) => child.stdin.once('data', resolve))
  ws.send(JSON.stringify(opened))
  await received
  const relayed = JSON.parse(child.requests.join('').split('\r\n\r\n')[1])
  assert.equal(hash(relayed.params.textDocument.text), hash(text))
  const before = child.requests.length
  const closed = new Promise((resolve) =>
    ws.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  )
  ws.send(
    JSON.stringify({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: 'file:///workspace/Large.lean', version: 2 },
        contentChanges: [{ text: 'a'.repeat(8 * 1024 * 1024 + 1) }],
      },
    }),
  )
  assert.deepEqual(await closed, {
    code: 1009,
    reason:
      'Lean source files must be at most 8 MiB. Reduce the file or split Lean sources into smaller modules.',
  })
  assert.equal(child.requests.length, before)
  assert.equal((await request('/health')).status, 200)
})

test('large-source support keeps dependency configuration capped at 2 MiB', async (t) => {
  const f = await fixture(t)
  const original = await f.workspaces.readFile(
    f.project.id,
    'owner',
    'lakefile.toml',
  )
  await assert.rejects(
    f.workspaces.writeFile(
      f.project.id,
      'owner',
      'lakefile.toml',
      'a'.repeat(2 * 1024 * 1024 + 1),
      original.hash,
    ),
    { status: 413 },
  )
  const uploaded = await f.request(`/api/projects/${f.project.id}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        {
          path: 'Nested/lakefile.toml',
          content: 'a'.repeat(2 * 1024 * 1024 + 1),
        },
      ],
    }),
  })
  assert.equal(uploaded.status, 413)
  assert.match((await uploaded.json()).error, /2 MiB/)
  assert.equal(
    (await f.workspaces.readFile(f.project.id, 'owner', 'lakefile.toml')).hash,
    original.hash,
  )
})

test('large-body routes authenticate without consuming anonymous uploads; login and settings retain their smaller limits', async (t) => {
  const f = await fixture(t)
  for (const [method, endpoint] of [
    ['POST', '/api/projects'],
    ['POST', `/api/projects/${f.project.id}/upload`],
    ['PUT', `/api/projects/${f.project.id}/file?path=Main.lean`],
  ]) {
    // Send only headers. A JSON parser placed before authentication would wait
    // for this declared body or reject its size rather than respond with 401.
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        f.url + endpoint,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length':
              method === 'PUT' ? 20 * 1024 * 1024 : 100 * 1024 * 1024,
          },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode)
          request.destroy()
        },
      )
      request.on('error', reject)
      request.setTimeout(2000, () =>
        request.destroy(
          new Error('Authentication waited for the anonymous body'),
        ),
      )
      request.flushHeaders()
    })
    assert.equal(response, 401)
  }
  for (const [endpoint, method, access] of [
    ['/api/login', 'POST', null],
    ['/api/settings', 'PUT', f.token],
  ]) {
    const response = await f.request(
      endpoint,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'a'.repeat(3 * 1024 * 1024 + 1) }),
      },
      access,
    )
    assert.equal(response.status, 413)
  }
})

test('an editable 8 MiB source still saves when JSON escaping expands its transport envelope sixfold', async (t) => {
  const f = await fixture(t)
  const content = '--' + '\u0001'.repeat(8 * 1024 * 1024 - 2)
  const response = await f.request(
    `/api/projects/${f.project.id}/file?path=Escaped.lean`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, expectedHash: null }),
    },
  )
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json()).hash, hash(content))
  assert.equal(
    hash(await fs.readFile(path.join(f.project.root, 'Escaped.lean'))),
    hash(content),
  )
})

test('parsed source saves retain admission while waiting for project writes', async (t) => {
  const f = await fixture(t)
  const writeFile = f.workspaces.writeFile.bind(f.workspaces)
  const pending = []
  f.workspaces.writeFile = (...args) =>
    new Promise((resolve, reject) => {
      pending.push(() => writeFile(...args).then(resolve, reject))
    })
  const save = (path) =>
    f.request(`/api/projects/${f.project.id}/file?path=${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '-- queued write', expectedHash: null }),
    })
  const first = save('First.lean'),
    second = save('Second.lean')
  t.after(() => pending.forEach((release) => release()))
  const deadline = Date.now() + 2000
  while (pending.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pending.length, 2)
  const blocked = await save('Third.lean')
  assert.equal(blocked.status, 429)
  assert.equal(
    pending.length,
    2,
    'The rejected save never reaches the workspace writer',
  )
  assert.equal((await f.request('/api/session')).status, 200)
  f.workspaces.writeFile = writeFile
  pending.shift()()
  assert.equal((await first).status, 200)
  assert.equal((await save('Third.lean')).status, 200)
  pending.shift()()
  assert.equal((await second).status, 200)
})

test('disconnecting parsed queued saves cannot release their source admission early', async (t) => {
  const f = await fixture(t, { sourceRequests: 2, sourceRequestsPerUser: 2 })
  const writeFile = f.workspaces.writeFile.bind(f.workspaces)
  const pending = []
  f.workspaces.writeFile = (...args) =>
    new Promise((resolve, reject) => {
      pending.push(() => writeFile(...args).then(resolve, reject))
    })
  const controllers = [new AbortController(), new AbortController()]
  const content = '-- ' + 'a'.repeat(5_400_000) + '\n'
  const saves = controllers.map((controller, index) =>
    fetch(
      f.url +
        `/api/projects/${f.project.id}/file?path=Disconnected${index}.lean`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${f.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, expectedHash: null }),
        signal: controller.signal,
      },
    ),
  )
  saves.forEach((save) => save.catch(() => {}))
  t.after(() => {
    controllers.forEach((controller) => controller.abort())
    pending.forEach((release) => release())
  })
  const deadline = Date.now() + 2000
  while (pending.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pending.length, 2)
  controllers.forEach((controller) => controller.abort())
  await Promise.allSettled(saves)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const next = () =>
    f.request(`/api/projects/${f.project.id}/file?path=Next.lean`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        expectedHash: null,
      }),
    })
  assert.equal((await next()).status, 429)
  assert.equal(pending.length, 2)
  assert.equal((await f.request('/api/session')).status, 200)
  f.workspaces.writeFile = writeFile
  pending.shift()()
  const released = Date.now() + 2000
  let response
  do {
    response = await next()
    if (response.status !== 429) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < released)
  assert.equal(response.status, 200, await response.text())
  await pending.shift()()
})
