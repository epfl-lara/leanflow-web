import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
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
