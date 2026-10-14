import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Terminals } from '../terminals.mjs'

test('terminal output and acknowledgements keep builds alive; a silent shell still expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const child = new EventEmitter()
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
  })
  child.kill = () => {
    if (child.killed) return
    child.killed = true
    child.emit('close', 0)
  }
  const ws = new EventEmitter()
  Object.assign(ws, {
    readyState: 1,
    send: () => {},
    ping: () => ws.emit('pong'),
  })
  ws.close = ws.terminate = () => {
    if (ws.readyState === 3) return
    ws.readyState = 3
    ws.emit('close')
  }
  const terminals = new Terminals({
    runtime: { spawn: () => child },
    capacity: {},
  })
  t.after(() => terminals.close())
  terminals.connect(ws, { id: 'fixture', root: '/unused' })
  for (let interval = 0; interval < 5; interval++) {
    t.mock.timers.tick(10 * 60_000)
    child.stdout.write(Buffer.from('build output'))
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'ack', bytes: 12 })),
      false,
    )
    assert.equal(
      child.killed,
      false,
      'an actively producing build stays alive past 30 minutes',
    )
  }
  t.mock.timers.tick(31 * 60_000)
  assert.equal(
    child.killed,
    true,
    'a shell with no input or output releases its worker',
  )
  await Promise.resolve()
})

test('terminal startup configures a public identity and buffers input until its private Git broker is ready', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'terminal-startup-'),
  )
  const workerHome = path.join(directory, 'private-home')
  await fs.mkdir(workerHome)
  const child = new EventEmitter()
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    workerHome,
    killed: false,
  })
  child.kill = () => {
    if (child.killed) return
    child.killed = true
    child.emit('close', 0)
  }
  const ws = new EventEmitter()
  Object.assign(ws, { readyState: 1, send() {}, ping() {} })
  ws.close = ws.terminate = () => {
    if (ws.readyState === 3) return
    ws.readyState = 3
    ws.emit('close')
  }
  let options, release
  const identity = new Promise((resolve) => (release = resolve))
  const terminals = new Terminals({
    runtime: {
      spawn(root, args, value) {
        options = value
        assert.equal(root, '/owned/checkout/Lean')
        assert.equal(args[0], 'python3')
        return child
      },
    },
    capacity: {},
    workspaces: {
      repositoryRoot: () => '/owned/checkout',
      configurationFingerprint: () => undefined,
    },
    gitConnections: { credentials: () => assert.fail('No Git operation yet') },
    gitIdentity: () => identity,
  })
  t.after(async () => {
    release({ name: 'Fixture User', email: 'fixture@example.test' })
    await terminals.closeProject('fixture')
    terminals.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  let input = ''
  child.stdin.on('data', (chunk) => (input += chunk))
  terminals.connect(ws, {
    id: 'fixture',
    owner: 'alice',
    root: '/owned/checkout/Lean',
  })
  ws.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'input', data: 'git status\r' })),
    false,
  )
  assert.equal(input, '')
  release({ name: 'Fixture User', email: 'fixture@example.test' })
  for (let attempt = 0; !input && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const frames = input.trim().split('\n').map(JSON.parse)
  assert.deepEqual(frames, [
    {
      type: 'setup',
      identity: { name: 'Fixture User', email: 'fixture@example.test' },
    },
    { type: 'input', data: 'git status\r' },
  ])
  assert.equal(options.repositoryRoot, '/owned/checkout')
  assert.equal(options.freshHome, true)
  assert.equal(options.cleanHome, true)
  assert.match(options.env.GIT_CONFIG_VALUE_1, /AF_UNIX/)
  assert(!Object.keys(options.env).some((key) => /TOKEN|PASSWORD/.test(key)))
  await terminals.closeProject('fixture')
  assert.equal(terminals.sessions.size, 0)
  await assert.rejects(fs.stat(workerHome), { code: 'ENOENT' })
})
