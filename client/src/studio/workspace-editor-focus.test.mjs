import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function delayedEditor() {
  let release
  let focused = 0
  const body = { matches: () => false }
  const document = { body, activeElement: body, querySelector: () => null }
  const host = {
    ownerDocument: document,
    isConnected: true,
    contains: () => false,
  }
  const module = { exports: {} }
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL('./workspaceEditor.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  )
  new Function('require', 'module', 'exports', outputText)(
    (name) => {
      if (name === 'monaco-editor')
        return {
          Uri: { parse: (uri) => uri },
          editor: {
            getModel: () => null,
            create: () => ({
              focus: () => {
                ++focused
              },
              dispose() {},
            }),
          },
        }
      assert.equal(name, 'vscode/monaco')
      return {
        createModelReference: () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ object: { textEditorModel: {} }, dispose() {} })
          }),
      }
    },
    module,
    module.exports,
  )
  const instance = new module.exports.WorkspaceEditor()
  return {
    instance,
    document,
    host,
    release: () => release(),
    focused: () => focused,
  }
}

test('finishing editor setup preserves the composer or other input chosen while loading', async () => {
  for (const kind of [
    'textarea',
    'input',
    'contenteditable',
    'search-button',
  ]) {
    const fixture = delayedEditor()
    const loading = fixture.instance.start(
      fixture.host,
      'file:///workspace/Main.lean',
      'example : True := by trivial',
    )
    fixture.document.activeElement = { kind, matches: () => false }
    fixture.release()
    await loading
    assert.equal(fixture.focused(), 0, kind)
  }
})

test('finishing editor setup respects an open modal and a detached workspace', async () => {
  for (const blocked of ['modal', 'detached']) {
    const fixture = delayedEditor()
    const loading = fixture.instance.start(
      fixture.host,
      'file:///workspace/Main.lean',
      '',
    )
    if (blocked === 'modal')
      fixture.document.querySelector = () => ({ open: true })
    else fixture.host.isConnected = false
    fixture.release()
    await loading
    assert.equal(fixture.focused(), 0, blocked)
  }
})

test('finishing editor setup focuses an idle page, the editor, or explicit file navigation', async () => {
  for (const target of ['idle', 'editor', 'file']) {
    const fixture = delayedEditor()
    const loading = fixture.instance.start(
      fixture.host,
      'file:///workspace/Main.lean',
      '',
    )
    if (target === 'editor') {
      fixture.document.activeElement = { matches: () => false }
      fixture.host.contains = () => true
    }
    if (target === 'file')
      fixture.document.activeElement = {
        matches: (selector) => selector === '.file-item',
      }
    fixture.release()
    await loading
    assert.equal(fixture.focused(), 1, target)
  }
})
