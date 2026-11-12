import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { validateWorkspaceFilePath } from './workspaces.mjs'

const MiB = 1024 * 1024
const defaultLimits = Object.freeze({
  fileBytes: 32 * MiB,
  archiveBytes: 64 * MiB,
  entries: 12000,
  scanEntries: 50000,
  timeoutMs: 30000,
})
const omittedDirectories = new Set([
  '.lake',
  '.cache',
  '.runtime',
  '.data',
  '.venv',
  '__pycache__',
  'node_modules',
])
const fail = (message, status = 400, code) => {
  throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
}
const cancelledDownload = () =>
  Object.assign(
    new Error('The download took too long or was cancelled. Try again.'),
    { status: 408 },
  )

export function isProjectDownloadPath(relative) {
  try {
    validateWorkspaceFilePath(relative)
    return !relative
      .split('/')
      .some(
        (part) =>
          omittedDirectories.has(part.toLowerCase()) || part === '.ready.json',
      )
  } catch (error) {
    if (error.status === 400) return false
    throw error
  }
}

function attachmentName(value) {
  return value.toWellFormed().replace(/[\\/\p{Cc}]/gu, '_') || 'project'
}

export function downloadDisposition(filename) {
  const name = attachmentName(path.posix.basename(filename))
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

async function* directoryEntries(directory) {
  let handle
  try {
    handle = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    if (
      (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !==
      path.resolve(directory)
    )
      fail('A project folder changed during download. Try again.', 409)
    const entries = await fs.opendir(`/proc/self/fd/${handle.fd}`)
    for await (const entry of entries)
      yield { entry, anchored: `/proc/self/fd/${handle.fd}/${entry.name}` }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code))
      fail('A project folder changed during download. Try again.', 409)
    throw error
  } finally {
    await handle?.close()
  }
}

function zipBytes(zip, signal) {
  return new Promise((resolve, reject) => {
    const stream = zip.generateInternalStream({
      type: 'nodebuffer',
      compression: 'STORE',
      platform: 'UNIX',
      streamFiles: true,
    })
    const chunks = []
    let size = 0,
      settled = false
    const finish = (error, content) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      chunks.length = 0
      if (error) reject(error)
      else resolve(content)
    }
    const abort = () => {
      if (settled) return
      // JSZip does not catch every exception thrown by a data/progress
      // callback. Pause its public stream and reject our own promise instead.
      stream.pause()
      finish(cancelledDownload())
    }
    stream
      .on('data', (chunk) => {
        if (settled) return
        chunks.push(chunk)
        size += chunk.length
      })
      .on('error', (error) => finish(error))
      .on('end', () => {
        if (settled) return
        try {
          finish(null, Buffer.concat(chunks, size))
        } catch (error) {
          finish(error)
        }
      })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else stream.resume()
  })
}

function downloadContext(
  workspaces,
  id,
  owner,
  { signal, limits: overrides } = {},
) {
  const project = workspaces.get(id, owner)
  const limits = { ...defaultLimits, ...overrides }
  signal = AbortSignal.any([
    AbortSignal.timeout(limits.timeoutMs),
    ...(signal ? [signal] : []),
  ])
  const check = () => {
    if (signal.aborted) throw cancelledDownload()
    workspaces.get(id, owner)
  }
  check()
  return { project, limits, signal, check }
}

async function* downloadEntries(project, limits, check, listing = false) {
  let entries = 0,
    scanned = 0
  const visit = async function* (relative = '') {
    check()
    const directory = path.join(project.root, relative)
    for await (const { entry, anchored } of directoryEntries(directory)) {
      check()
      if (++scanned > limits.scanEntries)
        fail(
          listing
            ? 'This project has too many entries to list for download.'
            : 'This project has too many entries to download as a ZIP.',
          413,
          'DOWNLOAD_SCAN_LIMIT',
        )
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (
        !isProjectDownloadPath(child) ||
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile())
      )
        continue
      if (++entries > limits.entries)
        fail(
          listing
            ? 'This project has too many files to list for download.'
            : 'This project has too many files to download as a ZIP.',
          413,
          'DOWNLOAD_ENTRY_LIMIT',
        )
      if (entry.isDirectory()) {
        yield { path: child, directory: true }
        yield* visit(child)
      } else {
        const stat = await fs.lstat(anchored)
        if (!stat.isFile())
          fail('A project file changed during download. Try again.', 409)
        yield { path: child, directory: false, size: stat.size }
      }
    }
  }
  yield* visit()
}

export async function listProjectDownloadFiles(workspaces, id, owner, options) {
  const { project, limits, check } = downloadContext(
    workspaces,
    id,
    owner,
    options,
  )
  const files = []
  for await (const entry of downloadEntries(project, limits, check, true))
    if (!entry.directory)
      files.push({
        path: entry.path,
        size: entry.size,
        downloadable: entry.size <= limits.fileBytes,
      })
  check()
  return { files, fileByteLimit: limits.fileBytes }
}

export async function createProjectDownload(
  workspaces,
  id,
  owner,
  filename,
  options,
) {
  const { project, limits, signal, check } = downloadContext(
    workspaces,
    id,
    owner,
    options,
  )
  if (filename !== undefined) {
    validateWorkspaceFilePath(filename)
    const file = await workspaces
      .readDownloadFile(id, owner, filename, {
        byteLimit: limits.fileBytes,
        signal,
      })
      .catch((error) => {
        check()
        throw error
      })
    check()
    return {
      content: file.content,
      filename: path.posix.basename(filename),
      type: 'application/octet-stream',
    }
  }
  const zip = new JSZip()
  let bytes = 0
  for await (const entry of downloadEntries(project, limits, check)) {
    const child = entry.path
    if (entry.directory) {
      zip.folder(child)
      continue
    }
    let file
    try {
      file = await workspaces.readDownloadFile(id, owner, child, {
        byteLimit: Math.min(limits.fileBytes, limits.archiveBytes - bytes),
        signal,
      })
    } catch (error) {
      check()
      if (error.status === 413)
        fail(
          'This ZIP exceeds the download limit (64 MiB total, 32 MiB per file). Download smaller files individually or use the project’s Git repository.',
          413,
          'DOWNLOAD_BYTE_LIMIT',
        )
      throw error
    }
    bytes += file.content.length
    zip.file(child, file.content, {
      createFolders: false,
      unixPermissions: file.mode,
    })
  }
  check()
  // STORE bounds CPU time and output size while retaining exact source bytes.
  const content = await zipBytes(zip, signal)
  check()
  return {
    content,
    filename: `${attachmentName(project.name)}.zip`,
    type: 'application/zip',
  }
}

export function installProjectDownloadRoutes(app, workspaces) {
  let active = 0
  const owners = new Set()
  app.get('/api/projects/:id/download', async (req, res) => {
    const owner = req.user.id
    workspaces.get(req.params.id, owner)
    if (active >= 2 || owners.has(owner)) {
      res.setHeader('Retry-After', '1')
      return res.status(429).json({
        error:
          'Downloads are busy. Wait for your current download and try again.',
      })
    }
    active++
    owners.add(owner)
    const controller = new AbortController()
    const onClose = () => controller.abort()
    res.once('close', onClose)
    try {
      const download = await createProjectDownload(
        workspaces,
        req.params.id,
        owner,
        req.query.path,
        { signal: controller.signal },
      )
      if (res.destroyed) return
      res.setHeader('Content-Type', download.type)
      res.setHeader(
        'Content-Disposition',
        downloadDisposition(download.filename),
      )
      await new Promise((resolve) => {
        res.once('finish', resolve)
        res.once('close', resolve)
        res.send(download.content)
      })
    } finally {
      res.off('close', onClose)
      active--
      owners.delete(owner)
    }
  })
}
