import fs from 'node:fs/promises'
import path from 'node:path'
import { clusterError } from './state.mjs'
import { editorConformance } from './editor-conformance.mjs'
import { removeDisposableTree } from '../temporary-workspaces.mjs'

// The runtime release path also handles a root removed by failed materialization
// and removes its dependency binding and home without needing realpath(root).
export async function cleanupEditorEnvironment(runtime, root) {
  await runtime.releaseVerificationWorkspace(root)
  await removeDisposableTree(root)
}

// Large public imports need their own cold-start check. A bare Lean capability
// does not establish that this dependency environment is ready for an editor.
export async function warmEditorEnvironment(
  runtime,
  root,
  {
    signal,
    prelude = 'import Mathlib\n',
    verifyEditor = editorConformance,
  } = {},
) {
  signal?.throwIfAborted()
  if (!['import Mathlib\n', 'import Lean\n'].includes(prelude))
    throw clusterError('Choose a supported public editor environment.')
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    prelude + 'example : True := by trivial\n',
    { mode: 0o600 },
  )
  const options = {
    signal,
    network: 'none',
    timeoutMs: 180000,
    readOnlyWorkspace: true,
    writeLakeCache: true,
    freshHome: true,
    cleanHome: true,
  }
  // Use the existing ordinary-check allocation, sequentially with the editor.
  // This heats the imported environment before the smaller language server.
  const started = performance.now()
  const compiled = await runtime.run(
    root,
    ['lake', 'env', 'lean', '--json', 'Main.lean'],
    { ...options, boundedScratchBytes: 16 * 1024 ** 3 },
  )
  if (
    compiled.code !== 0 ||
    compiled.timedOut ||
    compiled.cancelled ||
    compiled.truncated
  )
    throw clusterError(
      'The public editor environment did not pass its compiler warm-up.',
      'editor_environment_unavailable',
      503,
    )
  signal?.throwIfAborted()
  const compilerMs = Math.round(performance.now() - started)
  const editorStarted = performance.now()
  const editor = await verifyEditor(runtime, root, {
    ...options,
    prelude,
    boundedScratchBytes: 256 * 1024 ** 2,
  })
  return {
    compilerPassed: true,
    ...editor,
    timings: {
      compilerMs,
      editorMs: Math.round(performance.now() - editorStarted),
    },
  }
}
