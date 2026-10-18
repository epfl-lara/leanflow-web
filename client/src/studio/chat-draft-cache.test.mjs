import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

// Delay React's next render deliberately: a pending network response can run
// between the hook's synchronous cache write and that render's commit.
function draftBeforeNextRender() {
  let scheduled = 0
  const hooks = {
    useRef: (value) => ({ current: value }),
    useState: () => [
      0,
      () => {
        ++scheduled
      },
    ],
  }
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL('./chatDrafts.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  )
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    (name) => {
      assert.equal(name, 'react')
      return hooks
    },
    module,
    module.exports,
  )
  return {
    draft: module.exports.useChatDraft(
      'fixture-owner',
      'reconnecting-project',
      null,
    ),
    scheduled: () => scheduled,
  }
}

test('startup recovery sees a typed draft before the next React render', () => {
  const { draft, scheduled } = draftBeforeNextRender()
  const original = draft.capture()
  draft.setText('Keep my new question while chats reconnect.')
  assert.equal(scheduled(), 1)
  assert.equal(draft.value.text, 'Keep my new question while chats reconnect.')
  assert.notEqual(draft.value.revision, original.revision)
  assert.deepEqual(draft.value, {
    text: 'Keep my new question while chats reconnect.',
    files: [],
    revision: original.revision + 1,
    mode: 'proofs',
  })
})

test('startup recovery sees context and mode changes without replacing older snapshots', () => {
  const { draft, scheduled } = draftBeforeNextRender()
  const original = draft.value
  draft.setFiles(['Main.lean'])
  draft.setMode('search')
  assert.equal(scheduled(), 2)
  assert.deepEqual(draft.value.files, ['Main.lean'])
  assert.equal(draft.value.mode, 'search')
  assert.equal(draft.value.revision, original.revision + 2)
  assert.deepEqual(original.files, [])
  assert.equal(original.mode, 'proofs')
})
