import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'

function load(name, imports = {}) {
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL(name, import.meta.url), 'utf8'),
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
    (specifier) => {
      if (specifier in imports) return imports[specifier]
      throw new Error(`Unexpected module ${specifier}`)
    },
  )
  return module.exports
}
const { moveBlockedReason, moveProblem, moveRequestCurrent } = load(
  './moveEntryPaths.ts',
  {
    '../../../shared/project-configuration.mjs': {
      PROJECT_CONFIGURATION_FILES,
    },
  },
)
const { remapMovedPath, pathMoves } = load('./projectPaths.ts')

const request = {
  mode: 'rename',
  path: 'Main.lean',
  kind: 'file',
  projectId: 'project-a',
  userId: 'ann',
}

test('a pending move is only current in the project and account that opened it', () => {
  assert.equal(moveRequestCurrent(request, 'project-a', 'ann'), true)
  // Switching projects must never retarget the same-named path elsewhere.
  assert.equal(moveRequestCurrent(request, 'project-b', 'ann'), false)
  assert.equal(moveRequestCurrent(request, 'project-a', 'bob'), false)
  assert.equal(moveRequestCurrent(request, null, 'ann'), false)
  assert.equal(moveRequestCurrent(request, 'project-a', undefined), false)
  assert.equal(moveRequestCurrent(null, 'project-a', 'ann'), false)
})

test('playgrounds and setup files explain why Rename and Move are unavailable', () => {
  assert.match(moveBlockedReason('Main.lean', true), /Convert this playground/)
  for (const name of PROJECT_CONFIGURATION_FILES)
    assert.match(moveBlockedReason(name, false), /setup files/)
  assert.equal(moveBlockedReason('Main.lean', false), '')
  assert.equal(moveBlockedReason('Proofs/lakefile.lean', false), '')
})

test('destination problems are explained before anything is sent', () => {
  const file = { path: 'A/Main.lean', kind: 'file' }
  const existing = new Set(['A/Main.lean', 'A/Other.lean', 'B'])
  assert.equal(moveProblem(file, 'A/New.lean', existing), '')
  assert.match(moveProblem(file, 'A/Other.lean', existing), /already exists/)
  assert.match(moveProblem(file, 'A/Main.lean', existing), /same as/)
  assert.match(moveProblem(file, 'A/..', existing), /name without slashes/)
  assert.match(moveProblem(file, 'A\\x', existing), /name without slashes/)
  assert.match(moveProblem(file, 'lakefile.toml', existing), /setup files/)
  assert.match(
    moveProblem({ path: 'lean-toolchain', kind: 'file' }, 'Tools/t', existing),
    /setup files/,
  )
  const folder = { path: 'A', kind: 'folder' }
  assert.match(moveProblem(folder, 'A/Inner/A', existing), /into itself/)
  assert.equal(moveProblem(folder, 'AB/C', existing), '')
})

test('moved paths are remapped for files and folders without touching lookalikes', () => {
  assert.equal(remapMovedPath('A.lean', 'A.lean', 'B.lean'), 'B.lean')
  assert.equal(remapMovedPath('Dir/A.lean', 'Dir', 'X/Dir'), 'X/Dir/A.lean')
  assert.equal(remapMovedPath('Directory/A.lean', 'Dir', 'X'), null)
  assert.equal(remapMovedPath('Other.lean', 'A.lean', 'B.lean'), null)
})

test('live move messages are validated as untrusted input', () => {
  const good = { from: 'A.lean', to: 'B/A.lean' }
  assert.deepEqual(pathMoves([good]), [good])
  assert.deepEqual(pathMoves(undefined), [])
  assert.deepEqual(pathMoves('A'), [])
  assert.deepEqual(
    pathMoves([
      { from: 'A' },
      { from: 'A', to: 'A' },
      { from: 'A', to: 'A/B' },
      { from: '', to: 'B' },
      null,
      good,
    ]),
    [good],
  )
  assert.deepEqual(
    pathMoves(Array.from({ length: 40 }, () => good)),
    [],
    'an oversized list is ignored',
  )
})
