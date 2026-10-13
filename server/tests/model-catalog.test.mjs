import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { catalogModels, loadConfig } from '../config.mjs'
import { DEFAULT_MODEL, rcpModelCatalog } from '../model-catalog.mjs'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'

const nativeModel = (slug) => ({
  slug,
  display_name: slug,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: ['low', 'medium', 'high'].map((effort) => ({
    effort,
  })),
  model_context_window: 200000,
})

test('RCP selections match model encoders and preserve unrelated native metadata', () => {
  const expected = [
    [DEFAULT_MODEL, ['low', 'high', 'xhigh', 'max'], 'max'],
    ['deepseek-ai/DeepSeek-V4-Flash-0731', ['low', 'high', 'max'], 'low'],
    ['Qwen/Qwen3.8-Flash-Next', ['low', 'medium', 'xhigh'], 'xhigh'],
    ['Qwen/Qwen3.8-27B', ['low', 'medium', 'xhigh'], 'xhigh'],
    ['zai-org/GLM-5.2', ['high', 'max'], 'max'],
    ['zai-org/GLM-5.3-Flash', ['low', 'high', 'max'], 'max'],
    ['moonshotai/Kimi-K2.7-Code', [], null],
    ['Qwen/Qwen3.5-397B-A17B', [], null],
    ['Qwen/Qwen3-VL-235B-A22B-Thinking', [], null],
    ['Qwen/Qwen3.6-35B-A3B', [], null],
  ]
  const input = { models: expected.map(([id]) => nativeModel(id)) }
  const original = structuredClone(input)
  const catalog = rcpModelCatalog(input)
  const models = catalogModels(catalog, DEFAULT_MODEL)
  for (const [index, [id, levels, effort]] of expected.entries()) {
    assert.equal(models[index].id, id)
    assert.deepEqual(
      models[index].reasoningEfforts.map((level) => level.id),
      levels,
    )
    assert.equal(models[index].defaultReasoningEffort, effort)
    assert.equal(catalog.models[index].model_context_window, 200000)
  }
  assert.deepEqual(input, original)
  const unknown = nativeModel('custom/model')
  assert.deepEqual(rcpModelCatalog([unknown]).models, [unknown])
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-models-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const packaged = path.join(root, 'packaged')
  const host = path.join(root, 'host')
  const data = path.join(root, 'data')
  for (const dir of [packaged, host, data]) await fs.mkdir(dir)
  for (const [dir, models] of [
    [packaged, [nativeModel(DEFAULT_MODEL), nativeModel('Qwen/Qwen3.8-27B')]],
    [host, [nativeModel('host-only/model')]],
  ]) {
    await fs.writeFile(
      path.join(dir, 'config.toml'),
      'model = "host-only/model"\nmodel_catalog_json = "models.json"\n',
    )
    await fs.writeFile(
      path.join(dir, 'models.json'),
      JSON.stringify({ models }),
    )
  }
  return {
    data,
    host,
    options: { env: {}, packagedHome: pathToFileURL(packaged + '/') },
  }
}

test('startup uses the worker catalog and DeepSeek max rather than installed model defaults', async (t) => {
  const { data, options } = await fixture(t)
  const config = await loadConfig(data, options)
  assert.equal(config.defaultModel, DEFAULT_MODEL)
  assert.deepEqual(
    config.models.map((model) => model.id),
    [DEFAULT_MODEL, 'Qwen/Qwen3.8-27B'],
  )
  assert.equal(config.models[0].defaultReasoningEffort, 'max')
  assert.equal(config.modelCatalog.models[0].default_reasoning_level, 'max')
  assert.deepEqual(config.provider, {
    LEMEX_API_KEY: undefined,
    LEMEX_BASE_URL: undefined,
  })
})

test('explicit server catalog and model overrides remain available', async (t) => {
  const { data, host, options } = await fixture(t)
  const config = await loadConfig(data, {
    ...options,
    env: { LEMEX_HOME: host, STUDIO_MODEL: 'host-only/model' },
  })
  assert.equal(config.defaultModel, 'host-only/model')
  assert.deepEqual(
    config.models.map((model) => model.id),
    ['host-only/model'],
  )
})

test('run defaults use max; explicit selections are preserved and unsupported levels fail before execution', async (t) => {
  const { data, options } = await fixture(t)
  const config = await loadConfig(data, options)
  config.provider = { LEMEX_API_KEY: 'fixture' }
  const events = new EventStore(data)
  const manager = new AgentManager({
    events,
    config,
    maxConcurrent: 0,
    settings: {},
    runtime: {
      spawn() {
        assert.fail('No inference in selection tests')
      },
    },
    workspaces: { get: (id) => ({ id, status: 'ready' }) },
  })
  t.after(async () => {
    await manager.shutdown()
    events.close()
  })
  const input = { mode: 'proofs', prompt: 'Check the proof.' }
  for (const [index, effort] of [
    undefined,
    null,
    'low',
    'high',
    'xhigh',
    'max',
  ].entries()) {
    const job = await manager.start('alice', `p${index}`, { ...input, effort })
    assert.equal(job.model, DEFAULT_MODEL)
    assert.equal(job.effort, effort || 'max')
  }
  for (const effort of ['medium', 'ultra', 'unknown']) {
    await assert.rejects(
      () => manager.start('alice', 'invalid', { ...input, effort }),
      { status: 400 },
    )
  }
  await assert.rejects(
    () =>
      manager.start('alice', 'invalid', {
        ...input,
        model: 'Qwen/Qwen3.8-27B',
        effort: 'max',
      }),
    { status: 400 },
  )
})
