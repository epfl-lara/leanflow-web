import assert from 'node:assert/strict'
import test from 'node:test'
import { createHoverLookupGuard } from '../agent-hover-guard.mjs'

const hover = (id, fields = {}) => ({
  type: 'mcpToolCall',
  id: String(id),
  server: 'lean',
  tool: 'lean_hover_info',
  status: 'failed',
  arguments: { file_path: 'Main.lean', line: 14, column: id + 9 },
  error: { message: 'No hover information at this position' },
  ...fields,
})

function fixture(call = async () => ({ turnId: 'turn' })) {
  const active = {
    controller: new AbortController(),
    accepting: true,
    completed: false,
    threadId: 'thread',
    turnId: 'turn',
  }
  const requests = [],
    notices = [],
    errors = []
  let closed = 0
  const guard = createHoverLookupGuard({
    active,
    rpc: {
      call: (...args) => {
        requests.push(args)
        return call(...args)
      },
      close: () => {
        closed++
      },
    },
    onNotice: (message) => notices.push(message),
    onFailure: (error) => errors.push(error),
  })
  return { guard, active, requests, notices, errors, closed: () => closed }
}

test('column scanning is redirected once, then stopped after six misses on one line', async () => {
  const f = fixture()
  f.guard.handle(hover(0))
  f.guard.handle(hover(1))
  assert.equal(f.requests.length, 0)
  f.guard.handle(hover(2))
  await Promise.resolve()
  assert.equal(f.requests.length, 1)
  const [method, params] = f.requests[0]
  assert.equal(method, 'turn/steer')
  assert.equal(params.expectedTurnId, 'turn')
  assert.equal(params.threadId, 'thread')
  assert.match(params.input[0].text, /Main\.lean:14/)
  assert.match(params.input[0].text, /Stop scanning columns/)
  assert.equal(f.errors.length, 0)
  for (let id = 3; id < 166; id++) f.guard.handle(hover(id))
  assert.equal(f.requests.length, 1)
  assert.equal(f.notices.length, 1)
  assert.equal(f.errors.length, 1)
  assert.match(f.errors[0].message, /Stopped after repeated hover lookups/)
  assert.equal(f.active.accepting, false)
  assert.equal(f.closed(), 1)
})

test('empty hover results in MCP text content trigger the same recovery', () => {
  const f = fixture()
  for (let id = 0; id < 3; id++)
    f.guard.handle(
      hover(id, {
        status: 'completed',
        error: null,
        result: {
          content: [{ type: 'text', text: 'Error: No hover information' }],
        },
      }),
    )
  assert.equal(f.requests.length, 1)
})

test('successful hover, a changed file, and other source lines do not consume the same failure allowance', () => {
  const f = fixture()
  f.guard.handle(hover(0))
  f.guard.handle(hover(1))
  for (let id = 2; id < 30; id++)
    f.guard.handle(
      hover(id, {
        arguments: { file_path: 'Main.lean', line: id + 100, column: 1 },
      }),
    )
  f.guard.handle(
    hover(30, {
      status: 'completed',
      error: null,
      result: { content: [{ type: 'text', text: 'def size : Formula → Nat' }] },
    }),
  )
  f.guard.handle(hover(31))
  f.guard.handle(hover(32))
  f.guard.handle({ type: 'fileChange', status: 'completed' })
  f.guard.handle(hover(33))
  f.guard.handle(hover(34))
  assert.equal(f.requests.length, 0)
  assert.equal(f.errors.length, 0)
})

test('duplicate notifications, unrelated tools, invalid arguments, and other tool failures are ignored', () => {
  const f = fixture()
  for (let id = 0; id < 10; id++) {
    f.guard.handle(hover(0))
    f.guard.handle(hover(id, { tool: 'lean_local_search' }))
    f.guard.handle(hover(id + 20, { arguments: null }))
    f.guard.handle(hover(id + 40, { error: { message: 'Tool timed out' } }))
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.errors.length, 0)
})

test('failed or mismatched recovery acknowledgements stop a live loop', async () => {
  for (const call of [
    async () => {
      throw new Error('Disconnected')
    },
    async () => ({ turnId: 'different-turn' }),
  ]) {
    const f = fixture(call)
    for (let id = 0; id < 3; id++) f.guard.handle(hover(id))
    await Promise.resolve()
    assert.equal(f.errors.length, 1)
    assert.match(
      f.errors[0].message,
      /recovery guidance could not be delivered/,
    )
    assert.equal(f.closed(), 1)
  }
})

test('late recovery failures cannot change a finished or cancelled run', async () => {
  for (const finish of [
    (active) => {
      active.completed = true
    },
    (active) => {
      active.controller.abort()
    },
  ]) {
    let reject
    const f = fixture(
      () =>
        new Promise((_, no) => {
          reject = no
        }),
    )
    for (let id = 0; id < 3; id++) f.guard.handle(hover(id))
    finish(f.active)
    reject(new Error('Late failure'))
    await Promise.resolve()
    f.guard.handle(hover(4))
    assert.equal(f.errors.length, 0)
    assert.equal(f.closed(), 0)
  }
})
