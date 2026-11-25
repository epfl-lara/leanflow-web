import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ModelPreferences } from '../model-preferences.mjs'
import { DEFAULT_MODEL } from '../model-catalog.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-model-preferences-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, store: new ModelPreferences(root) }
}
const access = {
  models: [DEFAULT_MODEL, 'Qwen/Qwen3.8-27B', 'provider/extra'].map((id) => ({
    id,
  })),
  defaultModel: DEFAULT_MODEL,
}
const kimi = 'moonshotai/Kimi-K3.1-Pro'
const withKimi = { ...access, models: [...access.models, { id: kimi }] }

test('provider switches retain the RCP shortlist and keep other provider lists separate', async (t) => {
  const { store } = await fixture(t)
  await store.save('alice', ['Qwen/Qwen3.8-27B'], access)
  const custom = { ...access, providerId: 'other-provider', isRcp: false }
  assert.deepEqual(await store.get('alice', custom), [DEFAULT_MODEL])
  await store.save('alice', ['provider/extra'], custom)
  assert.deepEqual(await store.get('alice', access), ['Qwen/Qwen3.8-27B'])
  assert.deepEqual(await store.get('alice', custom), ['provider/extra'])
  assert.deepEqual(await store.get('bob', custom), [DEFAULT_MODEL])
  const restarted = new ModelPreferences(
    store.directory.replace(/model-preferences$/, ''),
  )
  assert.deepEqual(await restarted.get('alice', access), ['Qwen/Qwen3.8-27B'])
})

test('initial picker is small, key-aware, and includes the current Lemex default', async (t) => {
  const { store } = await fixture(t)
  assert.deepEqual(await store.get('alice', access), [
    DEFAULT_MODEL,
    'Qwen/Qwen3.8-27B',
  ])
  assert.deepEqual(
    await store.get('bob', {
      models: [{ id: 'only-available' }],
      defaultModel: 'only-available',
    }),
    ['only-available'],
  )
  assert.deepEqual(
    await store.get('missing-key', { models: [], defaultModel: null }),
    [],
  )
})

test('Kimi joins both new and existing pickers when their key offers it', async (t) => {
  const { store } = await fixture(t)
  assert.deepEqual(await store.get('new-account', withKimi), [
    DEFAULT_MODEL,
    'Qwen/Qwen3.8-27B',
    kimi,
  ])
  await fs.mkdir(store.directory)
  const previous = ['provider/extra', DEFAULT_MODEL]
  await fs.writeFile(
    store.filename('legacy'),
    JSON.stringify({ savedModels: previous }),
  )
  assert.deepEqual(await store.get('legacy', withKimi), [...previous, kimi])
  assert.deepEqual(await store.get('legacy', access), previous)

  await store.save('bob', previous, access)
  assert.deepEqual(await store.get('bob', withKimi), [...previous, kimi])
  await store.save('bob', [kimi, ...previous], withKimi)
  assert.deepEqual(await store.get('bob', withKimi), [kimi, ...previous])
  await assert.rejects(() => store.save('no-access', [kimi], access), {
    status: 400,
  })
})

test('removing Kimi persists across restarts and key changes for that provider', async (t) => {
  const { root, store } = await fixture(t)
  const custom = { ...withKimi, providerId: 'custom', isRcp: false }
  await Promise.all([
    store.save('alice', [], withKimi),
    store.save('alice', ['provider/extra', kimi], custom),
  ])

  const restarted = new ModelPreferences(root)
  assert.deepEqual(await restarted.get('alice', withKimi), [])
  assert.deepEqual(await restarted.get('alice', custom), [
    'provider/extra',
    kimi,
  ])
  await restarted.save('alice', [DEFAULT_MODEL], access)
  assert.deepEqual(await restarted.get('alice', withKimi), [DEFAULT_MODEL])
  await restarted.save('alice', [DEFAULT_MODEL, kimi], withKimi)
  assert.deepEqual(await restarted.get('alice', withKimi), [
    DEFAULT_MODEL,
    kimi,
  ])
})

test('adding Kimi to a full saved picker leaves room to save the full list', async (t) => {
  const { store } = await fixture(t)
  const ids = Array.from({ length: 100 }, (_, index) => `provider/${index}`)
  const large = { ...access, models: ids.map((id) => ({ id })) }
  await store.save('alice', ids, large)
  const expanded = { ...large, models: [...large.models, { id: kimi }] }
  const saved = await store.get('alice', expanded)
  assert.deepEqual(saved, [...ids, kimi])
  await store.save('alice', saved, expanded)
  assert.deepEqual(await store.get('alice', expanded), saved)
})

test('saved models persist per account without changing catalog access or defaults', async (t) => {
  const { root, store } = await fixture(t)
  const before = structuredClone(access)
  assert.deepEqual(
    await store.save(
      'alice',
      ['provider/extra', DEFAULT_MODEL, 'provider/extra'],
      access,
    ),
    ['provider/extra', DEFAULT_MODEL],
  )
  const restarted = new ModelPreferences(root)
  assert.deepEqual(await restarted.get('alice', access), [
    'provider/extra',
    DEFAULT_MODEL,
  ])
  assert.deepEqual(await restarted.get('bob', access), [
    DEFAULT_MODEL,
    'Qwen/Qwen3.8-27B',
  ])
  assert.deepEqual(access, before)
  assert.equal((await fs.stat(store.filename('alice'))).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readdir(store.directory), ['alice.json'])
  await store.save('alice', [], access)
  assert.deepEqual(await restarted.get('alice', access), [])
})

test('key changes retain unavailable saved choices without admitting unknown models', async (t) => {
  const { store } = await fixture(t)
  await store.save('alice', ['provider/extra'], access)
  const restricted = { models: [{ id: 'other' }], defaultModel: 'other' }
  assert.deepEqual(await store.get('alice', restricted), ['provider/extra'])
  await store.save('alice', ['provider/extra', 'other'], restricted)
  await assert.rejects(
    () => store.save('bob', ['provider/extra'], restricted),
    { status: 400 },
  )
  await assert.rejects(
    () => store.save('alice', ['arbitrary-unlisted'], restricted),
    { status: 400 },
  )
  assert.deepEqual(await store.get('alice', restricted), [
    'provider/extra',
    'other',
  ])
  await store.save('alice', ['other'], restricted)
  assert.deepEqual(await store.get('alice', restricted), ['other'])
})

test('invalid preference input and account paths are rejected without changing saved models', async (t) => {
  const { store } = await fixture(t)
  for (const value of [
    null,
    {},
    'model',
    [null],
    [''],
    ['x'.repeat(513)],
    Array(101).fill(DEFAULT_MODEL),
  ])
    await assert.rejects(() => store.save('alice', value, access), {
      status: 400,
    })
  await assert.rejects(() => store.save('../alice', [], access), {
    status: 400,
  })
  assert.deepEqual(await store.get('alice', access), [
    DEFAULT_MODEL,
    'Qwen/Qwen3.8-27B',
  ])
})
