import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const { outputText } = ts.transpileModule(
  fs.readFileSync(new URL('./renameModels.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
)
function fixture(createReference, current = () => null, cached = () => null) {
  const module = { exports: {} }
  new Function('exports', 'module', 'require', outputText)(
    module.exports,
    module,
    (name) => {
      if (name === 'monaco-editor')
        return {
          Uri: { parse: (uri) => uri },
          editor: { setModelLanguage: () => {}, getModel: cached },
        }
      if (name === 'vscode/monaco')
        return { createModelReference: createReference }
      throw new Error(`Unexpected import: ${name}`)
    },
  )
  const registered = [],
    changed = []
  const models = new module.exports.RenameModels(
    current,
    (sources) => registered.push(sources),
    (...args) => changed.push(args),
  )
  return { models, registered, changed }
}
function reference(content) {
  let disposed = false,
    released = false,
    listener
  const model = {
    getValue: () => content,
    getValueLength: () => content.length,
    setValue: (value) => {
      content = value
      listener?.()
    },
    isDisposed: () => disposed,
    dispose: () => {
      disposed = true
    },
    onDidChangeContent: (callback) => {
      listener = callback
      return {
        dispose: () => {
          listener = undefined
        },
      }
    },
  }
  return {
    object: { textEditorModel: model },
    dispose: () => {
      released = true
    },
    released: () => released,
  }
}
const source = {
  uri: 'file:///workspace/Main.lean',
  path: 'Main.lean',
  content: 'def blank := 0',
  hash: 'a'.repeat(64),
  unsaved: false,
}
const token = { isCancellationRequested: false }

test('preparing an owned unsaved rename model never writes or reloads its virtual file', async () => {
  const ref = reference(source.content)
  const current = Object.assign(ref.object.textEditorModel, {
    uri: { toString: () => source.uri },
  })
  const requests = []
  const f = fixture(
    async (...args) => {
      requests.push(args)
      return ref
    },
    () => current,
  )
  await f.models.prepare([source], token)
  assert.equal(requests[0][1], undefined)
  assert.deepEqual(f.registered, [[source]])
  current.setValue('def blankC := 0')
  assert.deepEqual(f.changed, [['Main.lean', 'def blankC := 0']])
  await f.models.dispose()
  assert(ref.released())
  assert(current.isDisposed())
})

test('rename preloads reuse a warm hidden model and reject changed text without writing it', async () => {
  const ref = reference(source.content),
    requests = []
  const f = fixture(
    async (...args) => {
      requests.push(args)
      return ref
    },
    () => null,
    () => ref.object.textEditorModel,
  )
  await assert.rejects(
    f.models.prepare([{ ...source, content: 'stale text' }], token),
    /changed while Lean prepared/,
  )
  assert.equal(requests.length, 0)
  await f.models.prepare([source], token)
  assert.equal(requests[0][1], undefined)
  assert.equal(ref.object.textEditorModel.getValue(), source.content)
  await f.models.dispose()
})

test('project disposal waits for in-flight model loading and releases it before the next project starts', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ref = reference(source.content)
  const f = fixture(() => gate)
  const preparing = f.models.prepare([source], token)
  const rejected = assert.rejects(preparing, /cancelled/)
  await Promise.resolve()
  let finished = false
  const disposing = f.models.dispose().then(() => {
    finished = true
  })
  await Promise.resolve()
  assert.equal(finished, false)
  release(ref)
  await rejected
  await disposing
  assert(ref.released())
  assert(ref.object.textEditorModel.isDisposed())
  assert.deepEqual(f.registered, [])
})

test('a cancellation while loading cannot dispose a model retained by the next rename', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ref = reference(source.content)
  const f = fixture(() => gate)
  const cancelled = { isCancellationRequested: false }
  const first = f.models.prepare([source], cancelled)
  const rejected = assert.rejects(first, /cancelled/)
  await Promise.resolve()
  cancelled.isCancellationRequested = true
  const second = f.models.prepare([source], token)
  release(ref)
  await rejected
  await second
  assert.equal(ref.released(), false)
  assert.deepEqual(f.registered, [[source]])
  await f.models.dispose()
})
