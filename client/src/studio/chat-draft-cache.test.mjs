import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { MAX_PROJECT_FILES } from '../../../shared/source-limits.mjs'

const projectPaths = (() => {
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL('./projectPaths.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  )
  const module = { exports: {} }
  new Function('exports', 'module', 'require', outputText)(
    module.exports,
    module,
    (name) => {
      assert.equal(name, '../../../shared/source-limits.mjs')
      return { MAX_PROJECT_FILES }
    },
  )
  return module.exports
})()

// Delay React's next render deliberately: a pending network response can run
// between the hook's synchronous cache write and that render's commit.
function draftBeforeNextRender() {
  let scheduled = 0
  const hooks = {
    useEffect: () => {},
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
      if (name === './projectPaths') return projectPaths
      assert.equal(name, 'react')
      return hooks
    },
    module,
    module.exports,
  )
  return {
    module: module.exports,
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

const target = {
  path: 'Old/Proof.lean',
  startLine: 3,
  endLine: 7,
  source: 'theorem t : True := trivial',
  name: 't',
}
const draft = (extra = {}) => ({
  text: 'prove it',
  files: ['Old/Proof.lean', 'Other.lean'],
  revision: 4,
  mode: 'proofs',
  proofTarget: target,
  ...extra,
})

test('moving a file re-keys attachments and the focused proof, keeping its source baseline', () => {
  const { module } = draftBeforeNextRender()
  const moved = module.moveDraftPaths(draft(), 'Old/Proof.lean', 'New.lean')
  assert.deepEqual(moved.files, ['New.lean', 'Other.lean'])
  assert.deepEqual(moved.proofTarget, { ...target, path: 'New.lean' })
  assert.equal(moved.text, 'prove it')
  assert.equal(moved.revision, 5)
})

test('moving a folder re-keys nested paths and leaves lookalike siblings alone', () => {
  const { module } = draftBeforeNextRender()
  const moved = module.moveDraftPaths(
    draft({ files: ['Old/A.lean', 'Older/B.lean'] }),
    'Old',
    'Archive/Old',
  )
  assert.deepEqual(moved.files, ['Archive/Old/A.lean', 'Older/B.lean'])
  assert.equal(moved.proofTarget.path, 'Archive/Old/Proof.lean')
})

test('an unrelated move returns no draft change', () => {
  const { module } = draftBeforeNextRender()
  assert.equal(module.moveDraftPaths(draft(), 'Unrelated', 'Elsewhere'), null)
})

test('stored drafts of every chat for this account and project are re-keyed, and no others', () => {
  const { module } = draftBeforeNextRender()
  const storage = new Map()
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    get length() {
      return storage.size
    },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  }
  try {
    const keys = {
      current: module.chatDraftKey('ann', 'project', null),
      chat: module.chatDraftKey('ann', 'project', 'chat-1'),
      otherProject: module.chatDraftKey('ann', 'other', null),
      otherUser: module.chatDraftKey('bob', 'project', null),
    }
    for (const key of Object.values(keys))
      storage.set(key, JSON.stringify(draft()))
    module.moveStoredDrafts('ann', 'project', 'Old/Proof.lean', 'New.lean')
    for (const key of [keys.current, keys.chat]) {
      const stored = JSON.parse(storage.get(key))
      assert.deepEqual(stored.files, ['New.lean', 'Other.lean'])
      assert.equal(stored.proofTarget.path, 'New.lean')
    }
    for (const key of [keys.otherProject, keys.otherUser])
      assert.deepEqual(JSON.parse(storage.get(key)).files, [
        'Old/Proof.lean',
        'Other.lean',
      ])
  } finally {
    globalThis.localStorage = previous
  }
})
