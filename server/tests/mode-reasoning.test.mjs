import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  modeReasoningEffort,
  reasoningPreferenceKey,
  selectedReasoningEffort,
} from '../../shared/mode-reasoning.mjs'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'

const reasoningModel = {
  id: 'fixture/model',
  reasoningEfforts: ['low', 'medium', 'high', 'max'].map((id) => ({ id })),
  defaultReasoningEffort: 'medium',
}

test('Ask and Search prefer high; all proof workflows prefer max', () => {
  for (const [mode, expected] of [
    ['ask', 'high'],
    ['search', 'high'],
    ['proofs', 'max'],
    ['formalize', 'max'],
    ['optimize', 'max'],
    ['repair', 'max'],
    ['prove', 'max'],
  ])
    assert.equal(modeReasoningEffort(mode, reasoningModel), expected, mode)
})

test('missing mode levels use only an advertised default, otherwise no override', () => {
  const limited = {
    ...reasoningModel,
    reasoningEfforts: [{ id: 'low' }, { id: 'medium' }],
  }
  for (const mode of ['search', 'proofs', 'formalize', 'optimize']) {
    assert.equal(modeReasoningEffort(mode, limited), 'medium')
    assert.equal(
      modeReasoningEffort(mode, { ...limited, defaultReasoningEffort: 'max' }),
      null,
    )
    assert.equal(modeReasoningEffort(mode, { id: 'fixed' }), null)
    assert.equal(
      modeReasoningEffort(mode, {
        reasoningEfforts: [],
        defaultReasoningEffort: 'max',
      }),
      null,
    )
  }
})

test('deliberate choices remain independent across workflows, models, and providers', () => {
  const preferences = {}
  const selected = (mode, model = reasoningModel, provider = 'rcp') =>
    selectedReasoningEffort(preferences, provider, model, mode)
  assert.equal(selected('search'), 'high')
  preferences[reasoningPreferenceKey('rcp', reasoningModel.id, 'search')] =
    'low'
  assert.equal(selected('search'), 'low')
  for (const mode of ['proofs', 'formalize', 'optimize'])
    assert.equal(selected(mode), 'max')
  preferences[reasoningPreferenceKey('rcp', reasoningModel.id, 'proofs')] = null
  assert.equal(selected('proofs'), null)
  assert.equal(selected('formalize'), 'max')
  assert.equal(selected('search'), 'low')
  assert.equal(selected('search', { ...reasoningModel, id: 'another' }), 'high')
  assert.equal(selected('search', reasoningModel, 'custom'), 'high')
  assert.equal(selected('proofs', reasoningModel, 'custom'), 'max')
  assert.equal(selected('search'), 'low')
  assert.equal(selected('proofs'), null)
})

test('automatic choices follow refreshed metadata while unsupported explicit choices stay visible', () => {
  const preferences = {}
  const refreshed = {
    ...reasoningModel,
    reasoningEfforts: [{ id: 'medium' }],
  }
  assert.equal(
    selectedReasoningEffort(preferences, 'rcp', reasoningModel, 'search'),
    'high',
  )
  assert.equal(
    selectedReasoningEffort(preferences, 'rcp', refreshed, 'search'),
    'medium',
  )
  preferences[reasoningPreferenceKey('rcp', reasoningModel.id, 'search')] =
    'max'
  assert.equal(
    selectedReasoningEffort(preferences, 'rcp', refreshed, 'search'),
    'max',
  )
  assert.equal(
    selectedReasoningEffort(preferences, 'rcp', reasoningModel, 'search'),
    'max',
  )
})

test('legacy per-model automatic efforts cannot override workflow defaults', () => {
  const legacy = { [reasoningModel.id]: 'max' }
  assert.equal(
    selectedReasoningEffort(legacy, 'rcp', reasoningModel, 'search'),
    'high',
  )
  assert.equal(
    selectedReasoningEffort(legacy, 'rcp', reasoningModel, 'proofs'),
    'max',
  )
})

test('agent API omitted effort follows workflow defaults and preserves explicit provider default', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-mode-reasoning-'),
  )
  const events = new EventStore(root)
  const config = {
    provider: { LEMEX_API_KEY: 'offline-fixture' },
    models: [reasoningModel],
    defaultModel: reasoningModel.id,
    redact: String,
  }
  const manager = new AgentManager({
    events,
    config,
    settings: {},
    runtime: {
      spawn: () => assert.fail('No provider calls in reasoning tests'),
    },
    workspaces: { get: (id) => ({ id, status: 'ready' }) },
    maxConcurrent: 0,
    maxQueue: 100,
  })
  t.after(async () => {
    await manager.shutdown()
    events.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  let index = 0
  const start = (mode, options = {}) =>
    manager.start('fixture', `project-${index++}`, {
      mode,
      prompt: 'Explain or prove the fixture theorem.',
      file: 'Main.lean',
      ...options,
    })
  for (const mode of [
    'search',
    'proofs',
    'formalize',
    'optimize',
    'repair',
    'prove',
  ]) {
    assert.equal((await start(mode)).effort, mode === 'search' ? 'high' : 'max')
    assert.equal((await start(mode, { effort: 'low' })).effort, 'low')
    assert.equal((await start(mode, { effort: null })).effort, null)
    await assert.rejects(() => start(mode, { effort: 'ultra' }), {
      status: 400,
    })
  }
  config.models = [{ ...reasoningModel, reasoningEfforts: [{ id: 'medium' }] }]
  for (const mode of ['search', 'proofs', 'formalize', 'optimize']) {
    assert.equal((await start(mode)).effort, 'medium')
    await assert.rejects(() => start(mode, { effort: 'high' }), { status: 400 })
  }
  config.models = [{ id: 'fixed' }]
  config.defaultModel = 'fixed'
  assert.equal((await start('search')).effort, null)
  assert.equal((await start('proofs')).effort, null)
})
