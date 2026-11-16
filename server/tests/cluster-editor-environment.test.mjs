import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupEditorEnvironment,
  warmEditorEnvironment,
} from '../cluster/editor-environment.mjs'
import { Runtime } from '../runtime.mjs'
import { sha256 } from '../cluster/state.mjs'

async function root(t) {
  const value = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lf-editor-environment-'),
  )
  t.after(() => fs.rm(value, { recursive: true, force: true }))
  return value
}

test('public compiler warm-up precedes same-profile LSP diagnostics without inference or network', async (t) => {
  const directory = await root(t)
  const phases = []
  const signal = new AbortController().signal
  const runtime = {
    run: async (actual, args, options) => {
      phases.push('compiler')
      assert.equal(actual, directory)
      assert.deepEqual(args, ['lake', 'env', 'lean', '--json', 'Main.lean'])
      assert.equal(options.network, 'none')
      assert.equal(options.signal, signal)
      assert.equal(
        options.editor,
        undefined,
        'warm-up uses the ordinary batch allocation',
      )
      assert.equal(
        await fs.readFile(path.join(directory, 'Main.lean'), 'utf8'),
        'import Mathlib\nexample : True := by trivial\n',
      )
      return { code: 0 }
    },
  }
  const report = await warmEditorEnvironment(runtime, directory, {
    signal,
    verifyEditor: async (actual, actualRoot, options) => {
      phases.push('editor')
      assert.equal(actual, runtime)
      assert.equal(actualRoot, directory)
      assert.equal(options.prelude, 'import Mathlib\n')
      assert.equal(options.network, 'none')
      assert.equal(options.boundedScratchBytes, 256 * 1024 ** 2)
      return {
        initialized: true,
        invalidDiagnostic: true,
        correctedDiagnostic: true,
        savedMirror: true,
      }
    },
  })
  assert.deepEqual(phases, ['compiler', 'editor'])
  assert.equal(report.compilerPassed, true)
  assert.equal(report.savedMirror, true)
  assert(report.timings.compilerMs >= 0)
  assert(report.timings.editorMs >= 0)
})

for (const missing of [false, true])
  test(`real runtime cleanup removes warm-up bindings and homes when its source ${missing ? 'is already absent' : 'exists'}`, async (t) => {
    const dataDir = await root(t)
    const runtime = new Runtime({ dataDir })
    const workspace = path.join(dataDir, 'editor-warmups', 'abandoned')
    const key = sha256(workspace)
    const binding = path.join(
      runtime.runtimeDir,
      'shared-dependency-bindings',
      key + '.json',
    )
    const home = path.join(runtime.runtimeDir, 'homes', key)
    await fs.mkdir(path.dirname(binding), { recursive: true, mode: 0o700 })
    await fs.mkdir(home, { recursive: true, mode: 0o700 })
    await fs.writeFile(binding, '{}')
    await fs.writeFile(
      path.join(runtime.runtimeDir, 'dependencies.json'),
      JSON.stringify({
        [workspace]: path.join(
          runtime.runtimeDir,
          'shared-dependencies',
          'public',
        ),
      }),
    )
    if (!missing) await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
    await cleanupEditorEnvironment(runtime, workspace)
    for (const filename of [workspace, binding, home])
      await assert.rejects(fs.stat(filename), { code: 'ENOENT' })
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(runtime.runtimeDir, 'dependencies.json'),
          'utf8',
        ),
      )[workspace],
      undefined,
    )
  })

test('real runtime cleanup retains a warm-up workspace while its container remains active', async (t) => {
  const dataDir = await root(t)
  const runtime = new Runtime({ dataDir })
  const workspace = path.join(dataDir, 'editor-warmups', 'active')
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
  runtime.children.add({ workspaceRoot: workspace })
  await assert.rejects(
    cleanupEditorEnvironment(runtime, workspace),
    /still stopping/,
  )
  assert((await fs.stat(workspace)).isDirectory())
})

test('a failed warm-up never proceeds to language-server qualification', async (t) => {
  const directory = await root(t)
  let editor = false
  await assert.rejects(
    warmEditorEnvironment({ run: async () => ({ code: 1 }) }, directory, {
      verifyEditor: async () => {
        editor = true
      },
    }),
    { code: 'editor_environment_unavailable' },
  )
  assert.equal(editor, false)
})

test('shutdown between warming and LSP verification starts no new editor', async (t) => {
  const directory = await root(t),
    abort = new AbortController()
  let editor = false
  await assert.rejects(
    warmEditorEnvironment(
      {
        run: async () => {
          abort.abort(new Error('stopping'))
          return { code: 0 }
        },
      },
      directory,
      {
        signal: abort.signal,
        verifyEditor: async () => {
          editor = true
        },
      },
    ),
    /stopping/,
  )
  assert.equal(editor, false)
})
