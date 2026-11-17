import test from 'node:test'
import assert from 'node:assert/strict'
import { editorQueueNotice } from '../../shared/editor-queue.mjs'

test('queue notices carry bounded public positions, without identities or arbitrary text', () => {
  assert.deepEqual(
    editorQueueNotice({
      state: 'waiting',
      position: 2,
      total: 4,
      actor: 'private',
      message: '<script>',
    }),
    { state: 'waiting', position: 2, total: 4 },
  )
  assert.deepEqual(editorQueueNotice({ state: 'starting' }), {
    state: 'starting',
  })
  assert.deepEqual(editorQueueNotice({ state: 'active' }), { state: 'active' })
  for (const value of [
    null,
    {},
    { state: 'waiting', position: 0, total: 1 },
    { state: 'waiting', position: 2, total: 1 },
    { state: 'waiting', position: NaN, total: 1 },
    { state: 'waiting', position: 1, total: 10001 },
  ])
    assert.equal(editorQueueNotice(value), null)
})
