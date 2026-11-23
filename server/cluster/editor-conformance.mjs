import fs from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { LspFrames, frame } from '../rpc.mjs'
import { FramedRpc } from './protocol.mjs'
import { RemoteEditor } from './editor-stream.mjs'
import { WorkerEditor } from './worker-editor.mjs'
import { clusterError, sha256 } from './state.mjs'

// Real pinned Lean, using the same chunk/ACK adapters as an SSH session. This
// grants a capability only after invalid and corrected source both elaborate.
export async function editorConformance(runtime, root, options) {
  const repository = options.repository === true
  const helper = 'ClusterConformance/EditorDependency.lean'
  const prelude = repository
    ? 'import ClusterConformance.EditorDependency\n'
    : options.prelude || ''
  const upstream = new PassThrough(),
    downstream = new PassThrough()
  const node = new FramedRpc(upstream, downstream)
  const controller = new FramedRpc(downstream, upstream)
  const abort = new AbortController()
  const signal = AbortSignal.any([
    abort.signal,
    ...(options.signal ? [options.signal] : []),
  ])
  const worker = new WorkerEditor({
    id: 'editor-conformance',
    peer: node,
    abort,
  })
  const editor = new RemoteEditor({
    rpc: controller,
    id: 'editor-conformance',
    cancel: () => abort.abort(),
    sync: (content, revision, filename) =>
      controller.request('editor.sync', {
        ...(filename ? { path: filename } : {}),
        revision,
        hash: sha256(content),
        size: Buffer.byteLength(content),
        offset: 0,
        data: Buffer.from(content).toString('base64'),
      }),
  })
  const ready = Promise.withResolvers()
  const pending = new Map(),
    diagnostics = []
  let stderr = '',
    closing = false,
    phase = 'initialize'
  const frames = new LspFrames((message) => {
    if (message.id != null && !message.method && pending.has(message.id)) {
      pending.get(message.id).result = message
      pending.get(message.id).resolve(message)
    }
    if (message.method === 'textDocument/publishDiagnostics')
      diagnostics.push(message.params)
  })
  editor.stdout.on('data', (bytes) => {
    try {
      frames.push(bytes)
    } catch (error) {
      abort.abort(error)
    }
  })
  editor.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-4000)
  })
  controller.handle('editor.ready', () => {
    ready.resolve()
    return { ready: true }
  })
  node.handle('editor.input', (value) => worker.input(value))
  node.handle('editor.sync', (value) => worker.sync(value))
  if (repository) {
    await fs.mkdir(path.dirname(path.join(root, helper)), { recursive: true })
    await fs.writeFile(
      path.join(root, helper),
      'def mirrorRevision : Nat := 1\n',
      { mode: 0o600 },
    )
  }
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    prelude + 'example : True := by trivial\n',
  )
  const run = worker.run(
    runtime,
    root,
    { ...options, signal },
    repository
      ? {
          entries: ['Main.lean', helper].map((file) => ({
            type: 'file',
            path: file,
          })),
        }
      : undefined,
  )
  run.then(
    (result) => {
      if (!closing)
        abort.abort(
          clusterError(
            `Editor stopped during ${phase} (exit ${result.code}). ${stderr.slice(-1200)}`,
            'conformance_failed',
            503,
          ),
        )
    },
    () => {},
  )
  run.catch((error) => {
    ready.reject(error)
    abort.abort(error)
  })
  const wait = async (condition) => {
    const deadline = Date.now() + 180000
    while (!condition()) {
      signal.throwIfAborted()
      if (Date.now() > deadline)
        throw clusterError(
          `Editor conformance timed out during ${phase}. ${stderr.slice(-1200)} ${JSON.stringify(diagnostics.slice(-2)).slice(-1200)}`,
          'conformance_failed',
          503,
        )
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    await Promise.race([
      ready.promise,
      run.then(() => {
        throw new Error('Editor exited before initialization.')
      }),
    ])
    await options.checkPlacement?.()
    const initialize = Promise.withResolvers()
    pending.set(1, initialize)
    editor.stdin.write(
      frame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          processId: null,
          rootUri: 'file:///workspace',
          capabilities: {},
        },
      }),
    )
    await wait(() => pending.get(1).result)
    const initialized = await initialize.promise
    if (!initialized.result?.capabilities)
      throw new Error('Lean initialization failed.')
    editor.stdin.write(
      frame({ jsonrpc: '2.0', method: 'initialized', params: {} }),
    )
    phase = 'invalid proof diagnostic'
    editor.stdin.write(
      frame({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: 'file:///workspace/Main.lean',
            languageId: 'lean4',
            version: 1,
            text: prelude + 'example : False := by trivial\n',
          },
        },
      }),
    )
    await wait(() =>
      diagnostics.some(
        (value) =>
          value.version === 1 &&
          value.diagnostics.some((diagnostic) => diagnostic.severity === 1),
      ),
    )
    const saved =
      prelude + '-- remote-editor-saved\nexample : True := by trivial\n'
    if (repository) await editor.syncFile('Main.lean', saved, 1)
    else await editor.syncMain(saved, 1)
    if ((await fs.readFile(path.join(root, 'Main.lean'), 'utf8')) !== saved)
      throw new Error('Editor save mirroring failed.')
    const checkImport = repository
      ? '  unless mirrorRevision == 1 do throw (IO.userError "missing initial import")\n'
      : ''
    const corrected = `${prelude}example : True := by trivial\n#eval do\n${checkImport}  let saved ← IO.FS.readFile "Main.lean"\n  unless saved == ${JSON.stringify(saved)} do throw (IO.userError "stale saved mirror")\n  IO.println "LEANFLOW_REMOTE_EDITOR_SAVED"\n`
    phase = 'corrected proof and saved-file read'
    editor.stdin.write(
      frame({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: 'file:///workspace/Main.lean', version: 2 },
          contentChanges: [{ text: corrected }],
        },
      }),
    )
    await wait(() =>
      diagnostics.some(
        (value) =>
          value.version === 2 &&
          !value.diagnostics.some((diagnostic) => diagnostic.severity === 1) &&
          value.diagnostics.some((diagnostic) =>
            String(diagnostic.message).includes('LEANFLOW_REMOTE_EDITOR_SAVED'),
          ),
      ),
    )
    if (repository) {
      phase = 'rebuilding a saved local dependency in the same editor'
      await editor.syncFile(helper, 'def mirrorRevision : Nat := 2\n', 2)
      const uri = 'file:///workspace/Main.lean'
      editor.stdin.write(
        frame({
          jsonrpc: '2.0',
          method: 'textDocument/didClose',
          params: { textDocument: { uri } },
        }),
      )
      editor.stdin.write(
        frame({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri,
              languageId: 'lean4',
              version: 3,
              text:
                prelude +
                '#eval do\n  unless mirrorRevision == 2 do throw (IO.userError "stale imported module")\n  IO.println "LEANFLOW_CHANGED_IMPORT_READY"\n',
            },
          },
        }),
      )
      await wait(() =>
        diagnostics.some(
          (value) =>
            value.uri === uri &&
            value.version === 3 &&
            value.diagnostics.some((item) =>
              String(item.message).includes('LEANFLOW_CHANGED_IMPORT_READY'),
            ) &&
            !value.diagnostics.some((item) => item.severity === 1),
        ),
      )
    }
    return {
      initialized: true,
      invalidDiagnostic: true,
      correctedDiagnostic: true,
      savedMirror: true,
      ...(repository
        ? { localImports: true, savedDependencyRebuilt: true }
        : {}),
    }
  } finally {
    closing = true
    editor.kill()
    await run
    editor.finish()
    node.close()
    controller.close()
  }
}
