import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAgentActivityHandler } from '../agent-activity.mjs'
import { EventStore } from '../events.mjs'
import { MAX_TOOL_STEPS, mergeToolStep } from '../../shared/tool-activity.mjs'

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'leanflow-activity-'))
  const events = new EventStore(directory)
  t.after(async () => {
    events.close()
    await rm(directory, { recursive: true, force: true })
  })
  const { id } = events.create('owner', { kind: 'agent', projectId: 'fixture' })
  const handler = createAgentActivityHandler({ events, id, ...options })
  const step = (index = -1) => events.getMetadata(id).toolActivity?.at(index)
  return { events, id, step, ...handler }
}

const check = (fields = {}) => ({
  id: 'check-1',
  type: 'mcpToolCall',
  server: 'lean_probe',
  tool: 'lean_check',
  arguments: {
    code: 'example : True := by trivial',
    file: '/workspace/Main.lean',
    line: 3,
  },
  ...fields,
})

test('activity survives persistence and completion keeps its original conversation position', async (t) => {
  const f = await fixture(t)
  f.events.updateMetadata(f.id, {
    message: 'Before check.',
    messageBaseOffset: 100,
    followups: [{ id: 'update' }],
  })
  assert.equal(f.handle('item/started', check()), true)
  const started = f.step()
  f.events.updateMetadata(f.id, {
    message: 'Before check. After check.',
    followups: [{ id: 'update' }, { id: 'next' }],
  })
  f.handle(
    'item/completed',
    check({
      status: 'completed',
      durationMs: 1250,
      result: { structuredContent: { success: true, ok: true } },
    }),
  )
  const completed = f.step()
  assert.equal(f.events.getMetadata(f.id).toolActivity.length, 1)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.checkResult, 'passed')
  assert.equal(completed.messageOffset, 113)
  assert.equal(completed.afterFollowups, 1)
  assert.equal(completed.startedAt, started.startedAt)
  assert.equal(completed.durationMs, 1250)
  assert.deepEqual(f.events.snapshot(f.id, 'owner').toolActivity, [completed])
  assert.deepEqual(
    f.events
      .events(f.id)
      .filter((event) => event.type === 'tool-step')
      .at(-1).data,
    completed,
  )
  assert.throws(() => f.events.snapshot(f.id, 'someone-else'), { status: 404 })
  f.handle('item/started', check())
  assert.deepEqual(
    f.step(),
    completed,
    'A repeated start must not revive a finished tool',
  )
})

test('Lean code, declaration replacements and tactics have readable source previews', async (t) => {
  const f = await fixture(t)
  for (const [field, inputLabel] of [
    ['code', 'Lean code'],
    ['replacement', 'Candidate declaration'],
    ['tactic', 'Tactic'],
  ]) {
    const source = 'theorem useful (h : True) : True := by\n  exact h\n'
    f.handle(
      'item/started',
      check({
        id: field,
        arguments: {
          [field]: source,
          file: 'Main.lean',
          line: 7,
          name: 'useful',
        },
      }),
    )
    assert.equal(f.step().input, source)
    assert.equal(f.step().inputLanguage, 'lean')
    assert.equal(f.step().inputLabel, inputLabel)
    assert.equal(f.step().detail, 'useful')
    assert.equal(f.step().path, 'Main.lean')
    assert.equal(f.step().line, 7)
  }
})

test('a completed tool call does not imply that Lean accepted a proof', async (t) => {
  const f = await fixture(t)
  for (const [result, expected] of [
    [{ ok: true }, undefined],
    [{ success: true }, undefined],
    [{ success: false, ok: true }, undefined],
    [{ success: true, ok: false }, 'issues'],
    [{ success: true, ok: true }, 'passed'],
  ]) {
    f.handle(
      'item/completed',
      check({
        id: JSON.stringify(result),
        status: 'completed',
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      }),
    )
    assert.equal(f.step().checkResult, expected)
    assert.equal(f.events.getMetadata(f.id).verification, undefined)
  }
  f.handle(
    'item/completed',
    check({
      id: 'read',
      tool: 'lean_goal',
      status: 'completed',
      result: { structuredContent: { success: true, ok: true } },
    }),
  )
  assert.equal(f.step().checkResult, undefined)
})

test('commands report explicit exit outcomes and readable file/search actions', async (t) => {
  const f = await fixture(t)
  for (const [type, kind, label] of [
    ['read', 'read', 'Read a file'],
    ['search', 'search', 'Search files'],
    ['listFiles', 'read', 'List files'],
    ['toString', 'command', 'Run a command'],
  ]) {
    f.handle('item/completed', {
      id: type,
      type: 'commandExecution',
      command: 'rg useful Main.lean',
      commandActions: [{ type, path: '/workspace/Main.lean', query: 'useful' }],
      exitCode: 0,
      aggregatedOutput: 'theorem useful : True := by trivial',
    })
    assert.equal(f.step().kind, kind)
    assert.equal(f.step().label, label)
    assert.equal(f.step().status, 'completed')
    assert.equal(f.step().checkResult, undefined)
    assert.equal(f.step().inputLanguage, 'shell')
  }
  for (const [index, [fields, status]] of [
    [{ exitCode: 1 }, 'failed'],
    [{ status: 'declined' }, 'declined'],
    [{}, 'finished'],
    [{ error: { message: 'failed' } }, 'failed'],
  ].entries()) {
    f.handle('item/completed', {
      id: `outcome-${index}`,
      type: 'commandExecution',
      command: 'lake build',
      ...fields,
    })
    assert.equal(f.step().status, status)
  }
})

test('tool previews redact credentials and terminal controls before clipping and persistence', async (t) => {
  const secret = 'fixture-provider-key-never-display'
  const f = await fixture(t, {
    secrets: [secret],
    redact: (text) => text.replaceAll('config-secret', '[redacted]'),
  })
  f.handle(
    'item/completed',
    check({
      tool: 'custom_lookup',
      status: 'completed',
      arguments: {
        api_key: 'hidden-key',
        Authorization: 'hidden-auth',
        nested: { refresh_token: 'hidden-refresh' },
        query: secret,
        config: 'config-secret',
      },
      result: {
        content: [
          { type: 'image', data: 'private-image-pixels' },
          {
            type: 'text',
            text: JSON.stringify({
              secret: 'hidden-result',
              message: `\u001b[31m\u202e${secret}${'x'.repeat(8000)}${secret}`,
            }),
          },
        ],
      },
    }),
  )
  const stored = JSON.stringify([
    f.events.getMetadata(f.id),
    f.events.events(f.id),
  ])
  for (const value of [
    secret,
    'config-secret',
    'hidden-key',
    'hidden-auth',
    'hidden-refresh',
    'hidden-result',
    'private-image-pixels',
  ])
    assert(!stored.includes(value), value)
  assert.match(f.step().input, /\[redacted\]/)
  assert.match(f.step().output, /preview shortened/)
  assert(!f.step().output.includes('\u001b'))
  assert(!f.step().output.includes('\u202e'))
  assert(f.step().output.length < 4100)
})

test('only safe workspace paths become file buttons; unknown tool names stay plain text', async (t) => {
  const f = await fixture(t)
  for (const file of [
    '../secret',
    '/etc/passwd',
    '/workspace/../secret',
    'C:\\secret',
    'a//b',
    'a/./b',
    'file:secret',
    'bad\nfile',
  ]) {
    f.handle(
      'item/started',
      check({ id: file, tool: '__proto__', arguments: { file } }),
    )
    assert.equal(f.step().path, undefined, file)
  }
  f.handle(
    'item/started',
    check({
      id: 'safe',
      tool: 'toString',
      arguments: { file: './Proofs/Main.lean', line: -3 },
    }),
  )
  assert.equal(f.step().path, 'Proofs/Main.lean')
  assert.equal(f.step().line, 1)
  assert.equal(f.step().kind, 'tool')
  assert.equal(f.step().label, 'toString')
})

test('file edits describe the working copy without claiming saved or verified project changes', async (t) => {
  const f = await fixture(t)
  f.handle('item/completed', {
    id: 'edit',
    type: 'fileChange',
    status: 'completed',
    changes: [
      { path: '/workspace/Main.lean', diff: 'sensitive-unbounded-diff' },
    ],
  })
  assert.equal(f.step().label, 'Edit working copy')
  assert.equal(f.step().path, 'Main.lean')
  assert.equal(f.step().inputLabel, 'Files')
  assert(!JSON.stringify(f.step()).includes('sensitive-unbounded-diff'))
  assert.equal(f.events.getMetadata(f.id).verification, undefined)
})

test('activity retention bounds rows and preview bodies while replay agrees with saved history', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < MAX_TOOL_STEPS + 5; index++) {
    f.handle(
      'item/completed',
      check({
        id: `tool-${index}`,
        status: 'completed',
        result: { content: [{ type: 'text', text: 'result '.repeat(900) }] },
      }),
    )
  }
  const job = f.events.getMetadata(f.id)
  assert.equal(job.toolActivity.length, MAX_TOOL_STEPS)
  assert.equal(job.toolActivity[0].id, 'tool-5')
  assert.equal(job.toolActivityTruncated, true)
  assert(
    job.toolActivity.some(
      (step) => step.detailsOmitted && !step.input && !step.output,
    ),
  )
  assert(
    job.toolActivity.reduce(
      (n, step) => n + (step.input?.length || 0) + (step.output?.length || 0),
      0,
    ) <= 48000,
  )
  const replay = f.events
    .events(f.id)
    .filter((event) => event.type === 'tool-step')
    .reduce((steps, event) => mergeToolStep(steps, event.data), [])
  assert.deepEqual(replay, job.toolActivity)
})

test('unrelated or malformed activity cannot create display records', async (t) => {
  const f = await fixture(t)
  for (const item of [
    null,
    {},
    { id: 3 },
    check({ id: 'x'.repeat(257) }),
    check({ type: 'reasoning' }),
  ])
    assert.equal(f.handle('item/started', item), false)
  assert.equal(f.handle('item/delta', check()), false)
  assert.equal(f.step(), undefined)
  // Unrecognized argument/result shapes from providers are harmless.
  f.handle(
    'item/completed',
    check({
      arguments: 'bad JSON',
      result: { content: [null, 3, { type: 'text', text: 5 }] },
    }),
  )
  assert.equal(f.step().status, 'finished')
})

test('a tool protocol error or unsuccessful checker execution needs attention even when the call completed', async (t) => {
  const f = await fixture(t)
  for (const [index, result] of [
    { isError: true, content: [{ type: 'text', text: 'Checker unavailable' }] },
    { structuredContent: { success: false, error: 'No project root found' } },
    {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            ok: false,
            error: 'Checker unavailable',
          }),
        },
      ],
    },
  ].entries()) {
    f.handle(
      'item/completed',
      check({ id: `failed-check-${index}`, status: 'completed', result }),
    )
    assert.equal(f.step().status, 'failed')
    assert.notEqual(f.step().checkResult, 'passed')
  }
})
