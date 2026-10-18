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
