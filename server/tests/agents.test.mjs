import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentOutputHandler } from '../agent-output.mjs'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'
import { Settings } from '../settings.mjs'

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-agents-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
function output(options = {}) {
  const chunks = [],
    text = { message: '', reasoning: '', reasoningSummary: '' }
  const handler = createAgentOutputHandler({
    ...options,
    append(field, chunk, type) {
      chunks.push({ field, text: chunk, type })
      text[field] += chunk
    },
  })
  return { handler, chunks, text }
}

test('streams native reasoning parts and summaries without repeating completed items', () => {
  const { handler, text, chunks } = output()
  handler.handle('item/started', {
    item: { type: 'reasoning', id: 'r1', summary: [], content: [] },
  })
  handler.handle('item/reasoning/summaryTextDelta', {
    itemId: 'r1',
    summaryIndex: 0,
    delta: 'Try induction.',
  })
  handler.handle('item/reasoning/textDelta', {
    itemId: 'r1',
    contentIndex: 0,
    delta: 'The successor case ',
  })
  handler.handle('item/reasoning/textDelta', {
    itemId: 'r1',
    contentIndex: 0,
    delta: 'uses the hypothesis.',
  })
  handler.handle('item/reasoning/summaryPartAdded', {
    itemId: 'r1',
    summaryIndex: 1,
  })
  handler.handle('item/reasoning/summaryTextDelta', {
    itemId: 'r1',
    summaryIndex: 1,
    delta: 'Check with Lean.',
  })
  handler.handle('item/completed', {
    item: {
      type: 'reasoning',
      id: 'r1',
      summary: ['Try induction.', 'Check with Lean.'],
      content: ['The successor case uses the hypothesis.', 'Now compile.'],
    },
  })
  handler.handle('item/agentMessage/delta', {
    itemId: 'm1',
    delta: 'Proof checked.',
  })
  handler.handle('item/completed', {
    item: { type: 'agentMessage', id: 'm1', text: 'Proof checked.' },
  })
  handler.flush()
  assert.deepEqual(text, {
    message: 'Proof checked.',
    reasoning: 'The successor case uses the hypothesis.\n\nNow compile.',
    reasoningSummary: 'Try induction.\n\nCheck with Lean.',
  })
  assert(
    chunks.some(
      (chunk) => chunk.field === 'reasoning' && chunk.type === 'reasoning',
    ),
  )
  assert(
    chunks.some(
      (chunk) =>
        chunk.field === 'reasoningSummary' &&
        chunk.type === 'reasoning-summary',
    ),
  )
})

test('captures plaintext completion fallback, ignores encrypted content, and leaves absent reasoning absent', () => {
  const { handler, text } = output()
  handler.handle('item/started', {
    item: { type: 'reasoning', id: 'r', summary: ['First step'], content: [] },
  })
  handler.handle('item/completed', {
    item: {
      type: 'reasoning',
      id: 'r',
      summary: [{ type: 'summary_text', text: 'First step done' }],
      publicReasoningContent: [
        { type: 'reasoning_text', text: 'Use rfl.' },
        { type: 'encrypted', text: 'hidden' },
      ],
    },
  })
  handler.handle('item/completed', {
    item: {
      type: 'reasoning',
      id: 'r',
      summary: ['First step done'],
      content: ['Use rfl.'],
    },
  })
  handler.handle('item/completed', {
    item: { type: 'agentMessage', id: 'm', text: 'Done.' },
  })
  handler.flush()
  assert.deepEqual(text, {
    message: 'Done.',
    reasoning: 'Use rfl.',
    reasoningSummary: 'First step done',
  })
  const absent = output()
  absent.handler.handle('item/completed', {
    item: { type: 'agentMessage', id: 'm', text: 'Done.' },
  })
  absent.handler.flush()
  assert.equal(absent.text.reasoning, '')
  assert.equal(absent.text.reasoningSummary, '')
})

test('distinct assistant items retain paragraph boundaries and final answers survive a long item sequence', () => {
  const { handler, text } = output()
  handler.handle('item/agentMessage/delta', {
    itemId: 'first',
    delta: 'First update.',
  })
  handler.handle('item/completed', {
    item: { type: 'agentMessage', id: 'first', text: 'First update.' },
  })
  handler.handle('item/completed', {
    item: { type: 'agentMessage', id: 'second', text: 'Second update.' },
  })
  for (let index = 0; index < 4500; index++)
    handler.handle('item/reasoning/textDelta', {
      itemId: `part${index}`,
      delta: 'x',
    })
  handler.handle('item/completed', {
    item: { type: 'agentMessage', id: 'final', text: 'Final checked result.' },
  })
  handler.handle('item/completed', {
    item: { type: 'agentMessage', id: 'final', text: 'Final checked result.' },
  })
  handler.flush()
  assert.equal(
    text.message,
    'First update.\n\nSecond update.\n\nFinal checked result.',
  )
})

test('unlimited output keeps bounded stored tails and a final answer with stable absolute followup offsets', async (t) => {
  const root = await directory(t),
    events = new EventStore(root)
  t.after(() => events.close())
  const job = events.create('alice', { kind: 'agent', projectId: 'p' })
  const secret = 'long-provider-secret'
  const handler = createAgentOutputHandler({
    secrets: [secret],
    append: (field, text, type) => events.append(job.id, field, text, type),
  })
  for (let index = 0; index < 10; index++) {
    handler.handle('item/agentMessage/delta', {
      itemId: 'progress',
      delta: 'm'.repeat(30_000),
    })
    handler.handle('item/reasoning/textDelta', {
      itemId: 'r',
      delta: 'r'.repeat(30_000),
    })
  }
  handler.flush()
  const before = events.get(job.id)
  assert.equal(before.message.length, 250_000)
  assert.equal(before.messageBaseOffset, 50_000)
  assert.equal(before.messageTruncated, true)
  assert.equal(before.reasoning.length, 250_000)
  assert.equal(before.reasoningTruncated, true)
  const offset = before.messageBaseOffset + before.message.length
  handler.handle('item/agentMessage/delta', {
    itemId: 'final',
    delta: 'Result: long-provider-',
  })
  handler.handle('item/agentMessage/delta', {
    itemId: 'final',
    delta: 'secret verified.',
  })
  handler.handle('item/completed', {
    item: {
      type: 'agentMessage',
      id: 'final',
      text: `Result: ${secret} verified.`,
    },
  })
  handler.flush()
  const final = events.get(job.id)
  assert.equal(final.message.length, 250_000)
  assert(final.message.endsWith('\n\nResult: [redacted] verified.'))
  assert(
    offset - final.messageBaseOffset > 0 &&
      offset - final.messageBaseOffset < final.message.length,
  )
  assert(!JSON.stringify(events.events(job.id)).includes(secret))
  const last = events
    .events(job.id)
    .filter((event) => event.type === 'message')
    .at(-1)
  assert.equal(last.data.baseOffset, final.messageBaseOffset)
  assert.equal(last.data.truncated, true)
})

test('raw reasoning preference leaves summaries enabled and supports legacy public notifications', () => {
  const { handler, text } = output({ showReasoning: false })
  handler.handle('codex/event/agent_reasoning_delta', {
    msg: { delta: 'Legacy summary.' },
  })
  handler.handle('codex/event/agent_reasoning', {
    msg: { text: 'Legacy summary.' },
  })
  handler.handle('codex/event/agent_reasoning_raw_content_delta', {
    msg: { delta: 'Private raw.' },
  })
  handler.handle('item/completed', {
    item: {
      type: 'reasoning',
      id: 'new',
      summary: ['Modern summary.'],
      content: ['Private raw.'],
    },
  })
  handler.handle('codex/event/agent_reasoning', {
    msg: { text: 'Modern summary.' },
  })
  handler.flush()
  assert.equal(text.reasoning, '')
  assert.equal(text.reasoningSummary, 'Legacy summary.\n\nModern summary.')
})

test('redacts secrets split across streaming deltas and bounds event chunks without dropping later output', () => {
  const secret = 'provider-secret-key'
  const { handler, text, chunks } = output({
    secrets: [secret],
    limit: 100_000,
  })
  handler.handle('item/reasoning/textDelta', {
    itemId: 'r',
    delta: 'Before provider-sec',
  })
  handler.handle('item/reasoning/textDelta', {
    itemId: 'r',
    delta: 'ret-key after. ' + 'x'.repeat(120_000),
  })
  handler.flush()
  assert(text.reasoning.startsWith('Before [redacted] after. '))
  assert.equal(
    text.reasoning.length,
    'Before [redacted] after. '.length + 120_000,
  )
  assert(!JSON.stringify(chunks).includes(secret))
  assert(chunks.every((chunk) => chunk.text.length <= 16_000))
})

test('coalesces many native deltas into bounded live events and flushes completed item tails immediately', async () => {
  const { handler, text, chunks } = output({ flushIntervalMs: 10 })
  for (let index = 0; index < 100; index++)
    handler.handle('item/reasoning/textDelta', { itemId: 'r', delta: 'step ' })
  assert.equal(chunks.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(chunks.length, 1)
  assert.equal(text.reasoning, 'step '.repeat(100))
  handler.flush()
  const tail = output({ secrets: ['long-provider-secret'] })
  tail.handler.handle('item/reasoning/textDelta', {
    itemId: 'r',
    delta: 'short',
  })
  assert.equal(tail.chunks.length, 0)
  tail.handler.handle('item/completed', {
    item: { type: 'reasoning', id: 'r', summary: [], content: ['short'] },
  })
  assert.equal(tail.text.reasoning, 'short')
  tail.handler.flush()
})

test('Stop flushes coalesced and redaction-held output before returning the cancelled run', async (t) => {
  const root = await directory(t),
    events = new EventStore(root)
  t.after(() => events.close())
  const job = events.create('alice', { kind: 'agent', projectId: 'p' })
  const handler = createAgentOutputHandler({
    secrets: ['long-provider-secret'],
    append: (field, text, type) => events.append(job.id, field, text, type),
  })
  handler.handle('item/reasoning/textDelta', { itemId: 'r', delta: 'short' })
  const manager = new AgentManager({
    events,
    runtime: {},
    workspaces: {},
    settings: {},
    config: { redact: String },
  })
  manager.active.set(job.id, {
    controller: new AbortController(),
    rpc: { close() {} },
    output: handler,
  })
  const stopped = await manager.stop('alice', job.id)
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.reasoning, 'short')
  assert.deepEqual(
    events.events(job.id).find((event) => event.type === 'reasoning').data,
    { text: 'short' },
  )
  manager.active.delete(job.id)
})

test('reasoning events persist independently and replay after reconnect', async (t) => {
  const root = await directory(t),
    events = new EventStore(root)
  const job = events.create('alice', { kind: 'agent', projectId: 'p' })
  const handler = createAgentOutputHandler({
    append: (field, text, type) => events.append(job.id, field, text, type),
  })
  handler.handle('item/reasoning/textDelta', {
    itemId: 'r',
    delta: 'Native reasoning.',
  })
  handler.handle('item/reasoning/summaryTextDelta', {
    itemId: 'r',
    delta: 'Native summary.',
  })
  handler.flush()
  events.update(job.id, { status: 'completed' })
  const cursor = events
    .events(job.id)
    .find((event) => event.type === 'reasoning').seq
  events.close()
  const replay = new EventStore(root)
  t.after(() => replay.close())
  assert.equal(replay.get(job.id, 'alice').reasoning, 'Native reasoning.')
  assert.equal(replay.get(job.id, 'alice').reasoningSummary, 'Native summary.')
  assert.deepEqual(
    replay
      .events(job.id, cursor)
      .find((event) => event.type === 'reasoning-summary').data,
    { text: 'Native summary.' },
  )
})

test('settings default to public raw reasoning, keep owner preferences private, and validate booleans', async (t) => {
  const root = await directory(t),
    settings = new Settings(root)
  const input = {
    extraInstructions: '',
    tools: { lean: true, lean_explore: false, exa: false },
  }
  assert.equal((await settings.get('alice')).showReasoning, true)
  await settings.save('alice', { ...input, showReasoning: false })
  assert.equal((await new Settings(root).get('alice')).showReasoning, false)
  assert.equal((await settings.save('alice', input)).showReasoning, false)
  assert.equal((await settings.get('bob')).showReasoning, true)
  for (const value of [null, 1, 'false', {}])
    await assert.rejects(
      settings.save('alice', { ...input, showReasoning: value }),
      { status: 400 },
    )
})

test('agent runs have no overall deadline by default but accept explicit finite limits', async (t) => {
  const root = await directory(t),
    events = new EventStore(root)
  t.after(() => events.close())
  const manager = new AgentManager({
    maxConcurrent: 0,
    events,
    workspaces: { get: (id) => ({ id, status: 'ready' }) },
    runtime: {
      spawn() {
        assert.fail('Queued policy tests must never launch a provider')
      },
    },
    settings: new Settings(root),
    config: {
      provider: { LEMEX_API_KEY: 'fake' },
      defaultModel: 'model',
      models: [{ id: 'model' }],
      redact: String,
    },
  })
  const input = { mode: 'prove', prompt: 'Prove the saved theorem.' }
  for (const [index, value] of [
    undefined,
    null,
    0,
    'unlimited',
    30,
    '1800',
  ].entries()) {
    const job = (await manager.start('alice', `p${index}`, {
      ...input,
      maxSeconds: value,
    }))
    assert.equal(job.maxSeconds, index < 4 ? null : Number(value))
  }
  for (const value of [
    false,
    true,
    {},
    [],
    '',
    'forever',
    -1,
    1,
    29,
    1801,
    30.5,
    Infinity,
  ])
    await assert.rejects(
      () => manager.start('alice', 'invalid', { ...input, maxSeconds: value }),
      { status: 400 },
    )
  await manager.shutdown()
  assert.equal(manager.active.size, 0)
})
