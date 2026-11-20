import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { MAX_PROJECT_FILES } from '../../../shared/source-limits.mjs'
import { chatModes } from './chatModes.ts'

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
      if (name === './chatModes') return { chatModes }
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
test('switching a focused draft to Informalize translates its statement and preserves custom wording', () => {
  const { draft, module } = draftBeforeNextRender()
  draft.focusTarget(target, 'proofs')
  draft.setMode('informalize')
  draft.setOutputFile('docs/Notes.md')
  assert.equal(draft.value.text, module.proofFocusPrompts.informalize)
  assert.deepEqual(draft.value.proofTarget, target)
  const saved = JSON.stringify(draft.value)
  const previous = globalThis.localStorage
  globalThis.localStorage = { getItem: () => saved }
  try {
    assert.deepEqual(module.readChatDraft(draft.key), draft.value)
  } finally {
    globalThis.localStorage = previous
  }
  draft.setMode('proofs')
  draft.setMode('formalize')
  assert.equal(draft.value.text, module.proofFocusPrompts.formalize)
  draft.setText('Please use the notation from Chapter 2.')
  draft.setMode('informalize')
  assert.equal(draft.value.text, 'Please use the notation from Chapter 2.')
  const sent = draft.capture()
  draft.setOutputFile('docs/New.tex')
  draft.clearSubmitted(sent)
  assert.equal(draft.value.text, 'Please use the notation from Chapter 2.')
  const moved = module.moveDraftPaths(draft.value, 'docs', 'paper')
  assert.equal(moved.outputFile, 'paper/New.tex')
})

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

test('setup scope survives accepted submissions and restoration without clearing a newer ordinary draft', () => {
  const { draft } = draftBeforeNextRender()
  draft.setMode('search')
  draft.setPurpose('setup')
  draft.setText('Diagnose this setup.')
  const submission = draft.capture()
  assert.equal(submission.purpose, 'setup')
  draft.clearSubmitted(submission, true)
  assert.equal(draft.value.text, '')
  assert.equal(draft.value.purpose, 'setup')
  draft.restoreSubmitted(submission)
  assert.equal(draft.value.text, submission.text)
  assert.equal(draft.value.purpose, 'setup')
  const next = draft.capture()
  draft.clearSubmitted(next, true)
  draft.setPurpose()
  draft.restoreSubmitted(next)
  assert.equal(draft.value.text, '')
  assert.equal(draft.value.purpose, undefined)
  draft.setText('Work on ordinary project files.')
  draft.clearSubmitted(submission, true)
  assert.equal(draft.value.text, 'Work on ordinary project files.')
})

test('ordinary mode choices and proof focus leave setup scope without losing draft text', () => {
  const { draft, module } = draftBeforeNextRender()
  draft.setText('Keep my instructions.')
  draft.setMode('search')
  draft.setPurpose('setup')
  draft.setMode('proofs')
  assert.equal(draft.value.purpose, undefined)
  assert.equal(draft.value.text, 'Keep my instructions.')
  draft.setMode('search')
  draft.setPurpose('setup')
  const focused = module.focusDraft(draft.value, target, 'proofs')
  assert.equal(focused.purpose, undefined)
  assert.deepEqual(focused.proofTarget, target)
  assert.equal(focused.text, 'Keep my instructions.')
})

test('saved setup drafts restore only the known purpose in Ask & Search', () => {
  const { module, draft } = draftBeforeNextRender()
  const storage = new Map()
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  }
  try {
    draft.setMode('search')
    draft.setPurpose('setup')
    draft.setText('Review configuration fixes.')
    const restored = module.readChatDraft(draft.key)
    assert.equal(restored.purpose, 'setup')
    assert.equal(restored.text, 'Review configuration fixes.')
    storage.set(
      draft.key,
      JSON.stringify({ ...restored, purpose: 'unrestricted' }),
    )
    assert.equal(module.readChatDraft(draft.key).purpose, undefined)
    storage.set(draft.key, JSON.stringify({ ...restored, mode: 'proofs' }))
    assert.equal(module.readChatDraft(draft.key).purpose, undefined)
    // A same-revision receipt cannot erase a scope changed in another tab.
    const submission = draft.capture()
    storage.set(draft.key, JSON.stringify({ ...restored, purpose: undefined }))
    draft.clearSubmitted(submission, true)
    assert.equal(draft.value.text, submission.text)
    assert.equal(
      module.clearDraftSubmission(
        { ...restored, purpose: undefined },
        submission,
      ),
      null,
    )
    assert.equal(
      module.restoreDraftSubmission(
        {
          ...restored,
          revision: submission.revision + 1,
          text: '',
          files: [],
          purpose: undefined,
        },
        submission,
      ),
      null,
    )
  } finally {
    globalThis.localStorage = previous
  }
})
