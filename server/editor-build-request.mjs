import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { savedFileSetup } from './project-file-cache.mjs'
import { relativeFile } from './workspace-paths.mjs'

// The worker receives only structured module names and Lean's import flags.
// The selected document body, arbitrary Lake arguments and paths are excluded.
function importHeader(value) {
  if (
    !value ||
    !Array.isArray(value.imports) ||
    value.imports.length > 4096 ||
    typeof value.isModule !== 'boolean'
  )
    return null
  const imports = []
  for (const item of value.imports) {
    const name = item?.module
    if (
      typeof name !== 'string' ||
      name.length > 512 ||
      name.split('.').some((part) => !part) ||
      /[\\/\p{Cc}]/u.test(name)
    )
      return null
    const entry = { module: name }
    for (const flag of ['importAll', 'isExported', 'isMeta']) {
      if (item[flag] === undefined) continue
      if (typeof item[flag] !== 'boolean') return null
      entry[flag] = item[flag]
    }
    imports.push(entry)
  }
  return { imports, isModule: value.isModule }
}

// An editor can request imports for a saved source. Only a separate offline
// compiler gets a writable mount of this project's published artifacts.
export function serveEditorBuilds(home, prepare) {
  const directory = fs.openSync(
    home,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  )
  const address = '/proc/self/fd/' + directory + '/.leanflow-build.sock'
  const sockets = new Set()
  const controller = new AbortController()
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(5000, () => socket.destroy())
    let size = 0
    const chunks = []
    socket.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) return socket.destroy()
      chunks.push(chunk)
    })
    socket.once('end', async () => {
      if (socket.destroyed) return
      socket.setTimeout(0)
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const file = relativeFile(request.file)
        const header = importHeader(request.header)
        if (!header && request.header !== null)
          throw new Error('Unsupported import header')
        if (
          !file.endsWith('.lean') ||
          file.split('/').some((part) => part.startsWith('.'))
        )
          throw new Error('Expected a project source')
        const result = await prepare(file, header, controller.signal)
        socket.end(JSON.stringify(result))
      } catch {
        socket.end(JSON.stringify({ status: 'private' }))
      }
    })
  })
  server.maxConnections = 8
  server.on('error', () => close())
  let closed = false
  function close() {
    if (closed) return
    closed = true
    controller.abort()
    for (const socket of sockets) socket.destroy()
    server.close(() => fs.closeSync(directory))
  }
  try {
    server.listen({ path: address, backlog: 8 })
    return close
  } catch (error) {
    close()
    throw error
  }
}

// Ensure the selected source is a regular file within the saved workspace.
// Resolution inside the worker also sees only its own project's mounts.
export async function prepareEditorBuild(runtime, root, file, header, signal) {
  const source = path.join(root, file)
  if (
    (await fs.promises.realpath(source)) !== source ||
    !(await fs.promises.stat(source)).isFile()
  )
    return { status: 'private' }
  if (!runtime.fileCheckCapacity()) return { status: 'busy' }
  let result
  try {
    result = await savedFileSetup(runtime, root, file, header, signal)
  } catch (error) {
    return error.status === 503
      ? { status: 'busy' }
      : {
          status: 'error',
          message: 'The shared import build stopped. Restart Lean to retry.',
        }
  }
  return result.code === 0
    ? { status: 'ready' }
    : {
        status: 'error',
        message: (
          result.stderr || 'The shared imports could not be built.'
        ).slice(-8000),
      }
}
