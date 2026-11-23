import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { SharedSourceRead, waitFor } from './shared-source-read.mjs'
import { localDependencyDirectories } from './dependency-layout.mjs'
import { managedWorkerFile } from './managed-worker-files.mjs'
import { fileURLToPath } from 'node:url'

const copier = fileURLToPath(new URL('./seed-file-check.py', import.meta.url))
const lib = '/.lake/build/lib/lean/'

// A private terminal or assistant starts with a copy of the saved build.
// The echo comes back only after flock acquires the directory. Closing stdin
// releases the reader, including when the server process goes away.
export async function withBuildCacheRead(
  root,
  signal,
  copy,
  { skipBusy = false } = {},
) {
  signal?.throwIfAborted()
  const args = skipBusy ? ['--nonblock', '--conflict-exit-code', '75'] : []
  const child = spawn(
    'flock',
    ['--shared', ...args, '--no-fork', root, 'cat'],
    {
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  )
  const closed = new Promise((resolve) => child.once('close', resolve))
  const abort = () => child.kill('SIGKILL')
  child.stdin.on('error', () => {})
  const acquired = once(child.stdout, 'data').then(() => true)
  const failed = once(child, 'error').then(([error]) => {
    throw error
  })
  signal?.addEventListener('abort', abort, { once: true })
  try {
    child.stdin.write('ready\n')
    const locked = await Promise.race([
      acquired,
      failed,
      closed.then((code) => {
        if (skipBusy && code === 75) return false
        throw new Error(
          'Could not read the saved project build. Retry opening the workspace.',
        )
      }),
    ])
    signal?.throwIfAborted()
    signal?.removeEventListener('abort', abort)
    if (!locked) return await copy(false)
    let clean = false
    try {
      await fs.lstat(path.join(root, '.lake/build/.leanflow-pending-build'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      clean = true
    }
    return await copy(clean)
  } finally {
    signal?.removeEventListener('abort', abort)
    child.stdin.end()
    await closed
    signal?.throwIfAborted()
  }
}

// Editors requesting the same configured file share an in-flight worker.
// Different files use the runtime queue and the same on-disk build lock.
const activeSetups = new WeakMap()
export async function savedFileSetup(runtime, root, file, header, signal) {
  const revision = (await fs.stat(root, { bigint: true })).ctimeNs.toString()
  let active = activeSetups.get(runtime)
  if (!active) activeSetups.set(runtime, (active = new Map()))
  const key = JSON.stringify([root, revision, file, header])
  let read = active.get(key)
  if (read && !read.active) {
    await waitFor(
      read.task.catch(() => {}),
      signal,
    )
    read = active.get(key)
  }
  if (!read) {
    signal?.throwIfAborted()
    read = new SharedSourceRead((sharedSignal) =>
      Promise.resolve()
        .then(() =>
          runtime.run(
            root,
            ['lake', 'setup-file', './' + file, ...(header ? ['-'] : [])],
            {
              ...(header && { input: JSON.stringify(header) + '\n' }),
              network: 'none',
              readOnlyWorkspace: true,
              writeLakeCache: true,
              savedImportRoot: root,
              freshHome: true,
              cleanHome: true,
              signal: sharedSignal,
              timeoutMs: 180000,
              maxOutputBytes: 8 * 1024 ** 2,
            },
          ),
        )
        .finally(() => active.delete(key)),
    )
    active.set(key, read)
  }
  return read.wait(signal)
}

// Ask the pinned Lake for the selected file's configured, transitive modules.
// A loose olean found in the project cache is never a reason to seed a check.
export async function seedFileCheck(
  runtime,
  projectRoot,
  snapshot,
  file,
  { signal, maxBytes },
) {
  let result
  try {
    result = await savedFileSetup(runtime, projectRoot, file, null, signal)
  } catch (error) {
    signal?.throwIfAborted()
    if (error.workerCleanup) throw error
    return false
  }
  signal?.throwIfAborted()
  if (result.code !== 0 || result.truncated) return false
  let imports
  try {
    imports = JSON.parse(result.stdout).importArts
  } catch {
    return false
  }
  if (!imports || typeof imports !== 'object' || Array.isArray(imports))
    return false
  const groups = new Map()
  let packages,
    count = 0
  for (const [name, parts] of Object.entries(imports)) {
    const stem = name.replaceAll('.', '/')
    const olean = Array.isArray(parts?.[0]) ? parts[0][0] : parts?.[0]
    const suffix = lib + stem + '.olean'
    if (
      typeof olean !== 'string' ||
      !olean.startsWith('/workspace/') ||
      !olean.endsWith(suffix) ||
      olean.startsWith('/workspace/.lake/packages/')
    )
      continue
    const parent = olean.slice('/workspace'.length, -suffix.length)
    const relative = parent.slice(1)
    if (relative) {
      if (!packages) {
        try {
          const manifest = managedWorkerFile(
            projectRoot,
            'lake-manifest.json',
            { maxBytes: 4 * 1024 ** 2 },
          )
          packages = new Set(
            localDependencyDirectories(JSON.parse(manifest || 'null')),
          )
        } catch {
          // An unavailable or changing manifest leaves Check File's captured
          // sources and the ordinary private compilation path intact.
          return false
        }
      }
      if (!packages.has(relative)) continue
    }
    if (++count > 4096) return false
    if (!groups.has(relative)) {
      if (groups.size >= 128) return false
      groups.set(relative, [])
    }
    groups.get(relative).push(stem)
  }
  if (!groups.size) return false
  // Wait for close, including cancellation, before the caller releases the
  // disposable source tree. No project code runs in this host-side copier.
  return new Promise((resolve, reject) => {
    const child = spawn(
      'python3',
      ['-I', copier, projectRoot, snapshot, String(maxBytes)],
      {
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    )
    const abort = () => child.kill('SIGKILL')
    const timer = setTimeout(abort, 30000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdin.on('error', () => {})
    child.on('error', () => {}) // A spawn failure also emits close.
    child.once('close', (code, termSignal) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(signal.reason)
      else if (termSignal || code === 2)
        reject(
          new Error(
            'The private import copy was interrupted. Retry the file check.',
          ),
        )
      else resolve(code === 0 ? [...groups.keys()] : false)
    })
    child.stdin.end(JSON.stringify([...groups]))
  })
}
