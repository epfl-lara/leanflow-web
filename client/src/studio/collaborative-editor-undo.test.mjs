import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
const { outputText } = ts.transpileModule(
  fs.readFileSync(
    new URL('./collaborativeEditorUndo.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
)
const module = { exports: {} }
new Function('module', 'exports', outputText)(module, module.exports)
const { installCollaborativeEditorUndo } = module.exports

test('all public model undo paths delegate to the shared document, including an empty local stack', () => {
  const calls = []
  const model = {
    undo() {
      calls.push('native undo')
    },
    redo() {
      calls.push('native redo')
    },
  }
  const originalUndo = model.undo,
    originalRedo = model.redo
  const guard = installCollaborativeEditorUndo(model, 'Main.lean', () => ({
    undo(path) {
      calls.push(`shared undo ${path}`)
      return true
    },
    redo(path) {
      calls.push(`shared redo ${path}`)
      return true
    },
  }))
  model.undo()
  model.redo()
  assert.deepEqual(calls, ['shared undo Main.lean', 'shared redo Main.lean'])
  guard.dispose()
  assert.equal(model.undo, originalUndo)
  assert.equal(model.redo, originalRedo)
})

test('unmanaged files retain native undo and disposal does not replace another model owner handler', () => {
  let native = 0
  const model = {
    undo() {
      assert.equal(this, model)
      native++
    },
    redo() {
      native++
    },
  }
  const guard = installCollaborativeEditorUndo(model, 'local.txt', () => ({
    undo: () => false,
    redo: () => false,
  }))
  model.undo()
  model.redo()
  assert.equal(native, 2)
  const newer = () => {}
  model.undo = newer
  guard.dispose()
  assert.equal(model.undo, newer)
})

test('an unsupported editor model fails before modifying its history', () => {
  assert.throws(
    () =>
      installCollaborativeEditorUndo({ undo() {} }, 'Main.lean', () => ({})),
    /Restore the pinned editor packages/,
  )
})
