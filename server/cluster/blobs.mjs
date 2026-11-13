import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { clusterError, digest, identifier, sha256 } from './state.mjs'
import { ObjectBudget, pythonBudget } from './budget.mjs'

const execute = promisify(execFile)
const MAX_CHUNK = 256 * 1024
export const MAX_MANIFEST = 64 * 1024 * 1024
export const MAX_ENTRIES = 250000
const STANDARD_MAX_MANIFEST = 32 * 1024 * 1024
const STANDARD_MAX_ENTRIES = 150000
const MAX_FILE = 2 * 1024 ** 3

function manifestLimits(kind) {
  return kind === 'dependencies'
    ? { bytes: MAX_MANIFEST, entries: MAX_ENTRIES }
    : { bytes: STANDARD_MAX_MANIFEST, entries: STANDARD_MAX_ENTRIES }
}
const secretParts = new Set([
  '.git',
  '.lemex',
  '.codex',
  '.ssh',
  '.aws',
  '.azure',
  '.config',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'auth.json',
])

export function contentPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    /[\x00-\x1f\\]/.test(value) ||
    Buffer.from(value).toString() !== value
  )
    throw clusterError('Invalid snapshot path.')
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw clusterError('Snapshot paths must stay inside their workspace.')
  return value
}

export function isPrivatePath(value) {
  return value
    .split('/')
    .some(
      (part) =>
        secretParts.has(part.toLowerCase()) ||
        /^\.env(?:\.|$)/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    )
}

function generatedGitEntry(entry, kind) {
  if (
    kind !== 'dependencies' ||
    !/^\.lake\/packages\/[^/]+\/\.git(?:\/|$)/.test(entry.path) ||
    isPrivatePath(entry.path.replace('/.git', '/generated-git'))
  )
    return false
  const relative = entry.path.split('/').slice(4).join('/')
  return entry.type === 'directory'
    ? relative === '' ||
        ['objects', 'refs'].includes(relative) ||
        /^objects\/[a-f0-9]{2}$/.test(relative)
    : entry.type === 'file' &&
        (['HEAD', 'shallow', 'config', 'index'].includes(relative) ||
          /^objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(relative))
}

export function validateManifest(value) {
  if (
    !value ||
    value.version !== 1 ||
    !['source', 'dependencies', 'toolchain', 'result'].includes(value.kind) ||
    !Array.isArray(value.entries) ||
    value.entries.length > manifestLimits(value.kind).entries
  )
    throw clusterError('Invalid snapshot manifest.')
  const names = new Map()
  const linksByName = new Map()
  let bytes = 0
  for (const entry of value.entries) {
    contentPath(entry?.path)
    if (isPrivatePath(entry.path) && !generatedGitEntry(entry, value.kind))
      throw clusterError(
        'Private configuration cannot enter a worker snapshot.',
      )
    if (names.has(entry.path)) throw clusterError('Duplicate snapshot path.')
    if (!['file', 'directory', 'symlink'].includes(entry.type))
      throw clusterError('Invalid snapshot entry type.')
    if (entry.type === 'file') {
      digest(entry.hash)
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_FILE ||
        ![0o600, 0o700].includes(entry.mode)
      )
        throw clusterError('Invalid snapshot file.')
      bytes += entry.size
      if (
        entry.mtimeNs !== undefined &&
        (typeof entry.mtimeNs !== 'string' ||
          !/^\d{1,19}$/.test(entry.mtimeNs) ||
          BigInt(entry.mtimeNs) > 9223372036854775807n)
      )
        throw clusterError('Invalid snapshot file time.')
      if (!Number.isSafeInteger(bytes))
        throw clusterError('Snapshot size exceeds its limit.')
    } else if (entry.type === 'symlink') {
      if (
        typeof entry.target !== 'string' ||
        !entry.target ||
        path.posix.isAbsolute(entry.target) ||
        /[\x00-\x1f\\]/.test(entry.target)
      )
        throw clusterError('Invalid snapshot link.')
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry.path), entry.target),
      )
      if (
        resolved === '..' ||
        resolved.startsWith('../') ||
        isPrivatePath(resolved)
      )
        throw clusterError('Snapshot link escapes the workspace.')
      linksByName.set(entry.path, entry.target)
    }
    names.set(entry.path, entry.type)
  }
  for (const entry of value.entries) {
    let parent = path.posix.dirname(entry.path)
    while (parent !== '.') {
      if (names.has(parent) && names.get(parent) !== 'directory')
        throw clusterError('A snapshot path traverses a file or link.')
      parent = path.posix.dirname(parent)
    }
    if (entry.type === 'symlink') {
      const resolved =
        path.posix.dirname(entry.path) === '.'
          ? []
          : path.posix.dirname(entry.path).split('/')
      const pending = entry.target.split('/')
      let links = 0
      while (pending.length) {
        const part = pending.shift()
        if (!part || part === '.') continue
        if (part === '..') {
          if (!resolved.length)
            throw clusterError('Snapshot link escapes the workspace.')
          resolved.pop()
          continue
        }
        resolved.push(part)
        const target = linksByName.get(resolved.join('/'))
        if (target !== undefined) {
          if (++links > 40)
            throw clusterError('Snapshot link chain is cyclic or too deep.')
          resolved.pop()
          pending.unshift(...target.split('/'))
        }
      }
      if (isPrivatePath(resolved.join('/')))
        throw clusterError('Snapshot link targets private state.')
    }
  }
  return { ...value, totalBytes: bytes }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// No object directory is mounted into a sandbox. Only validated private copies
// are writable by project code; immutable environment publication is separate.
export class BlobStore {
  constructor(
    directory,
    {
      reserveBytes = 1024 ** 3,
      maxBytes = 128 * 1024 ** 3,
      maxFiles = 500000,
    } = {},
  ) {
    this.directory = path.resolve(directory)
    this.objects = path.join(this.directory, 'objects')
    this.partial = path.join(this.directory, 'partial')
    this.reserveBytes = reserveBytes
    this.writes = new Map()
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(maxFiles) ||
      maxFiles < 1
    )
      throw clusterError('Invalid object-store budget.')
    this.maxBytes = maxBytes
    this.maxFiles = maxFiles
    this.manifestCache = new Map()
    this.manifestCacheBytes = 0
  }

  async init() {
    for (const directory of [this.directory, this.objects, this.partial]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const storage = await fs.stat(directory)
      if (storage.uid !== process.getuid() || storage.mode & 0o077)
        throw clusterError(
          'Worker objects require private service-owned directories.',
        )
      if (
        (await fs.realpath(directory)) !== directory ||
        !(await fs.lstat(directory)).isDirectory()
      )
        throw clusterError('Invalid worker object directory.')
    }
    this.budget = new ObjectBudget(
      path.join(this.directory, 'budget.sqlite'),
      this,
    )
    for (const directory of [this.objects, this.partial])
      for (const name of await fs.readdir(directory)) {
        const stat = await fs.lstat(path.join(directory, name))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw clusterError('Invalid object-store inventory.')
        this.budget.reserve(
          /^[a-f0-9]{64}$/.test(name)
            ? name
            : 'orphan:' + directory + '/' + name,
          stat.size,
          true,
        )
      }
    return this
  }

  usage() {
    return this.budget?.usage() || null
  }

  async reset() {
    if (this.writes.size)
      throw clusterError(
        'Drain object writes before clearing the cache.',
        'worker_busy',
        409,
      )
    for (const directory of [this.objects, this.partial])
      for (const name of await fs.readdir(directory))
        await fs.unlink(path.join(directory, name))
    this.budget.reset()
    this.manifestCache.clear()
    this.manifestCacheBytes = 0
  }

  close() {
    this.budget?.close()
    this.budget = null
  }

  object(hash) {
    return path.join(this.objects, digest(hash))
  }

  async verify(hash) {
    if ((await this.#fileDigest(this.object(hash))) !== hash)
      throw clusterError(
        'Worker object checksum mismatch.',
        'digest_mismatch',
        409,
      )
  }

  async putFile(filename, { signal } = {}) {
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const before = await handle.stat({ bigint: true })
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(MAX_FILE)
      )
        throw clusterError(
          'Image archive must be a regular file of at most 2 GiB.',
        )
      const buffer = Buffer.allocUnsafe(MAX_CHUNK),
        hasher = createHash('sha256')
      const totalBytes = Number(before.size)
      for (let offset = 0; offset < totalBytes;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, totalBytes - offset),
          offset,
        )
        if (!bytesRead)
          throw clusterError('Image archive changed while reading.')
        hasher.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      const hash = hasher.digest('hex')
      if (!(await this.has([hash])).length) {
        const partial = await this.offset(hash)
        const start = partial.complete ? totalBytes : partial.offset
        if (!Number.isSafeInteger(start) || start > totalBytes)
          throw clusterError('Invalid local image archive offset.')
        if (start === totalBytes)
          await this.writeChunk({
            hash,
            offset: start,
            totalBytes,
            data: '',
            final: true,
          })
        for (let offset = start; offset < totalBytes;) {
          signal?.throwIfAborted()
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, totalBytes - offset),
            offset,
          )
          if (!bytesRead)
            throw clusterError('Image archive changed while reading.')
          await this.writeChunk({
            hash,
            offset,
            data: buffer.subarray(0, bytesRead).toString('base64'),
            totalBytes,
            final: offset + bytesRead === totalBytes,
          })
          offset += bytesRead
        }
      }
      const after = await handle.stat({ bigint: true })
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw clusterError('Image archive changed while reading.')
      return { hash, size: totalBytes }
    } finally {
      await handle.close()
    }
  }

  async has(hashes) {
    if (!Array.isArray(hashes) || hashes.length > 2048)
      throw clusterError('Invalid object query.')
    return Promise.all(
      hashes.map(async (hash) => {
        const filename = this.object(hash)
        try {
          const stat = await fs.lstat(filename)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
            throw clusterError('Invalid stored worker object.')
          return hash
        } catch (error) {
          if (error.code === 'ENOENT') return null
          throw error
        }
      }),
    ).then((values) => values.filter(Boolean))
  }

  async put(data) {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data)
    if (data.length > MAX_FILE)
      throw clusterError('Worker object exceeds its limit.')
    const hash = sha256(data)
    if ((await this.has([hash])).length) return { hash, size: data.length }
    if (!data.length)
      await this.writeChunk({
        hash,
        offset: 0,
        data: '',
        totalBytes: 0,
        final: true,
      })
    for (let offset = 0; offset < data.length; offset += MAX_CHUNK) {
      const part = data.subarray(offset, offset + MAX_CHUNK)
      await this.writeChunk({
        hash,
        offset,
        data: part.toString('base64'),
        totalBytes: data.length,
        final: offset + part.length === data.length,
      })
    }
    return { hash, size: data.length }
  }

  async writeChunk(request) {
    digest(request?.hash)
    const prior = this.writes.get(request.hash) || Promise.resolve()
    const current = prior.catch(() => {}).then(() => this.#writeChunk(request))
    this.writes.set(request.hash, current)
    try {
      return await current
    } finally {
      if (this.writes.get(request.hash) === current)
        this.writes.delete(request.hash)
    }
  }

  async #writeChunk({ hash, offset, data, totalBytes, final }) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 0 ||
      totalBytes > MAX_FILE ||
      typeof final !== 'boolean' ||
      typeof data !== 'string' ||
      data.length > Math.ceil(MAX_CHUNK / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        data,
      )
    )
      throw clusterError('Invalid worker object chunk.')
    const content = Buffer.from(data, 'base64')
    if (
      content.toString('base64') !== data ||
      content.length > MAX_CHUNK ||
      offset + content.length > totalBytes ||
      (final && offset + content.length !== totalBytes)
    )
      throw clusterError('Invalid worker object chunk bounds.')
    if ((await this.has([hash])).length) {
      const stat = await fs.stat(this.object(hash))
      if (stat.size !== totalBytes)
        throw clusterError(
          'Worker object size mismatch.',
          'digest_mismatch',
          409,
        )
      return { offset: totalBytes, complete: true }
    }
    const space = await fs.statfs(this.directory)
    if (space.bavail * space.bsize - content.length < this.reserveBytes)
      throw clusterError('Worker storage reserve reached.', 'storage_full', 507)
    this.budget.reserve(hash, totalBytes)
    const filename = path.join(this.partial, hash)
    let handle
    try {
      try {
        handle = await fs.open(
          filename,
          constants.O_RDWR | constants.O_NOFOLLOW,
        )
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        handle = await fs.open(
          filename,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        )
      }
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== offset)
        throw clusterError(
          'Worker object offset changed.',
          'offset_conflict',
          409,
        )
      let written = 0
      while (written < content.length) {
        const result = await handle.write(
          content,
          written,
          content.length - written,
          offset + written,
        )
        if (!result.bytesWritten)
          throw clusterError('Worker object write made no progress.')
        written += result.bytesWritten
      }
      if (!final) return { offset: offset + content.length, complete: false }
      await handle.sync()
    } finally {
      await handle?.close()
    }
    const actual = await this.#fileDigest(filename)
    if (actual !== hash) {
      await fs.rm(filename, { force: true })
      throw clusterError(
        'Worker object checksum mismatch.',
        'digest_mismatch',
        409,
      )
    }
    await fs.chmod(filename, 0o400)
    await fs.rename(filename, this.object(hash))
    await syncDirectory(this.objects)
    return { offset: totalBytes, complete: true }
  }

  async offset(hash) {
    if ((await this.has([hash])).length) return { complete: true }
    try {
      const stat = await fs.lstat(path.join(this.partial, digest(hash)))
      if (!stat.isFile() || stat.nlink !== 1)
        throw clusterError('Invalid partial worker object.')
      return { complete: false, offset: stat.size }
    } catch (error) {
      if (error.code === 'ENOENT') return { complete: false, offset: 0 }
      throw error
    }
  }

  async readChunk(hash, offset = 0, length = MAX_CHUNK) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_CHUNK
    )
      throw clusterError('Invalid worker object read.')
    const handle = await fs.open(
      this.object(hash),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await handle.stat()
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        offset > stat.size ||
        stat.size > MAX_FILE
      )
        throw clusterError('Invalid worker object.')
      const buffer = Buffer.alloc(Math.min(length, stat.size - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      return {
        data: buffer.subarray(0, bytesRead).toString('base64'),
        offset: offset + bytesRead,
        totalBytes: stat.size,
        complete: offset + bytesRead === stat.size,
      }
    } finally {
      await handle.close()
    }
  }

  async read(hash, maxBytes = MAX_MANIFEST) {
    const handle = await fs.open(
      this.object(hash),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
        throw clusterError('Worker object exceeds its read limit.')
      const data = await handle.readFile()
      if (data.length > maxBytes || sha256(data) !== hash)
        throw clusterError(
          'Worker object checksum mismatch.',
          'digest_mismatch',
          409,
        )
      return data
    } finally {
      await handle.close()
    }
  }

  async manifest(hash, expectedKind) {
    digest(hash)
    const cached = this.manifestCache.get(hash)
    if (cached) {
      if (expectedKind && cached.value.kind !== expectedKind)
        throw clusterError('Invalid snapshot manifest kind.')
      this.manifestCache.delete(hash)
      this.manifestCache.set(hash, cached)
      return cached.value
    }
    let value
    let bytes
    try {
      bytes = await this.read(
        hash,
        expectedKind ? manifestLimits(expectedKind).bytes : MAX_MANIFEST,
      )
      value = JSON.parse(bytes.toString('utf8'))
      if (
        bytes.length > manifestLimits(value.kind).bytes ||
        (expectedKind && value.kind !== expectedKind)
      )
        throw clusterError('Invalid snapshot manifest.')
    } catch (error) {
      if (error.code === 'digest_mismatch') throw error
      throw clusterError('Invalid snapshot manifest.')
    }
    const valid = validateManifest(value)
    for (const entry of valid.entries) Object.freeze(entry)
    Object.freeze(valid.entries)
    Object.freeze(valid)
    while (
      this.manifestCacheBytes + bytes.length > 64 * 1024 ** 2 &&
      this.manifestCache.size
    ) {
      const first = this.manifestCache.keys().next().value
      this.manifestCacheBytes -= this.manifestCache.get(first).bytes
      this.manifestCache.delete(first)
    }
    this.manifestCache.set(hash, { value: valid, bytes: bytes.length })
    this.manifestCacheBytes += bytes.length
    return valid
  }

  async seal(entries, kind = 'source') {
    const value = validateManifest({ version: 1, kind, entries })
    const data = Buffer.from(
      JSON.stringify({ version: 1, kind, entries: value.entries }),
    )
    if (data.length > manifestLimits(kind).bytes)
      throw clusterError('Snapshot manifest exceeds its limit.')
    return {
      ...(await this.put(data)),
      totalBytes: value.totalBytes,
      entries: value.entries.length,
    }
  }

  async materialize(hash, destination, { signal } = {}) {
    const manifest = await this.manifest(hash)
    // The caller chooses a fresh, owned destination. Never merge into a tree
    // that a previous sandbox could have replaced with symlinks.
    await fs.mkdir(destination, { mode: 0o700 })
    try {
      for (const entry of manifest.entries) {
        signal?.throwIfAborted()
        if (entry.type !== 'directory') continue
        await fs.mkdir(path.join(destination, entry.path), {
          recursive: true,
          mode: 0o700,
        })
      }
      for (const entry of manifest.entries) {
        signal?.throwIfAborted()
        if (entry.type !== 'file') continue
        const output = path.join(destination, entry.path)
        await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
        if ((await this.#fileDigest(this.object(entry.hash))) !== entry.hash)
          throw clusterError(
            'Worker object checksum mismatch.',
            'digest_mismatch',
            409,
          )
        await fs.copyFile(
          this.object(entry.hash),
          output,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        )
        await fs.chmod(output, entry.mode)
        if (entry.mtimeNs !== undefined)
          await fs.utimes(
            output,
            Number(entry.mtimeNs) / 1e9,
            Number(entry.mtimeNs) / 1e9,
          )
        const durable = await fs.open(
          output,
          constants.O_RDWR | constants.O_NOFOLLOW,
        )
        try {
          await durable.sync()
        } finally {
          await durable.close()
        }
        if ((await fs.stat(output)).size !== entry.size)
          throw clusterError('Snapshot size mismatch.')
      }
      for (const entry of manifest.entries) {
        signal?.throwIfAborted()
        if (entry.type !== 'symlink') continue
        const output = path.join(destination, entry.path)
        await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
        await fs.symlink(entry.target, output)
      }
      const directories = new Set(['.'])
      for (const entry of manifest.entries) {
        let parent =
          entry.type === 'directory'
            ? entry.path
            : path.posix.dirname(entry.path)
        while (parent !== '.') {
          directories.add(parent)
          parent = path.posix.dirname(parent)
        }
      }
      for (const directory of [...directories].sort(
        (a, b) => b.length - a.length,
      ))
        await syncDirectory(path.join(destination, directory))
      return manifest
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true })
      throw error
    }
  }

  async #fileDigest(filename) {
    const file = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n)
        throw clusterError('Invalid worker object.')
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat({ bigint: true })
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw clusterError('Worker object changed during inspection.')
      return hash.digest('hex')
    } finally {
      await file.close()
    }
  }
}

const captureScript = String.raw`
import hashlib,json,os,signal,stat,sys,tempfile
root,objects,kind,ignore_lake,reserve,budget_filename,max_bytes,max_files,max_entries=sys.argv[1:]
ignore_lake=ignore_lake=='1'
reserve=int(reserve)
max_bytes=int(max_bytes);max_files=int(max_files);max_entries=int(max_entries)
${pythonBudget}
def interrupted(signum,frame):raise InterruptedError('Snapshot stopped')
signal.signal(signal.SIGTERM,interrupted)
secret={'.git','.lemex','.codex','.ssh','.aws','.azure','.config','.netrc','.npmrc','.pypirc','credentials','credentials.json','auth.json'}
entries=[]
total=0
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
def private(name):
 n=name.lower()
 return n in secret or n=='.env' or n.startswith('.env.') or n.endswith(('.pem','.key','.p12','.pfx'))
def walk(fd,prefix=''):
 global total
 with os.scandir(fd) as scan: names=sorted(entry.name for entry in scan)
 for name in names:
  if private(name) or (ignore_lake and not prefix and name=='.lake'):continue
  relative=prefix+'/'+name if prefix else name
  if len(entries)>=max_entries:raise ValueError('Too many snapshot entries')
  before=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if stat.S_ISLNK(before.st_mode):
   entries.append(dict(path=relative,type='symlink',target=os.readlink(name,dir_fd=fd)))
  elif stat.S_ISDIR(before.st_mode):
   child=os.open(name,flags|os.O_DIRECTORY,dir_fd=fd)
   try:
    actual=os.fstat(child)
    if (before.st_dev,before.st_ino)!=(actual.st_dev,actual.st_ino):raise ValueError('Snapshot directory changed')
    entries.append(dict(path=relative,type='directory'))
    walk(child,relative)
   finally:os.close(child)
  elif stat.S_ISREG(before.st_mode):
   source=os.open(name,flags,dir_fd=fd)
   out=None;temporary=None
   try:
    actual=os.fstat(source)
    if not stat.S_ISREG(actual.st_mode) or actual.st_size>2*1024**3:raise ValueError('Invalid snapshot input')
    if (before.st_dev,before.st_ino)!=(actual.st_dev,actual.st_ino):raise ValueError('Snapshot input changed')
    h=hashlib.sha256();size=0
    while True:
     chunk=os.read(source,1024*1024)
     if not chunk:break
     size+=len(chunk)
     if size>2*1024**3:raise ValueError('Snapshot input exceeds limit')
     h.update(chunk)
    after=os.fstat(source)
    if (actual.st_size,actual.st_mtime_ns,actual.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('Snapshot input changed')
    total+=size
    if total>512*1024**3:raise ValueError('Snapshot exceeds limit')
    target=os.path.join(objects,h.hexdigest())
    reserve_blob(h.hexdigest(),size)
    if not os.path.exists(target):
     out,temporary=tempfile.mkstemp(prefix='.capture-',dir=objects)
     os.lseek(source,0,os.SEEK_SET);copied=hashlib.sha256()
     while True:
      chunk=os.read(source,1024*1024)
      if not chunk:break
      space=os.statvfs(objects)
      if space.f_bavail*space.f_frsize-len(chunk)<reserve:raise OSError('Worker storage reserve reached')
      copied.update(chunk);view=memoryview(chunk)
      while view:
       count=os.write(out,view)
       if count<=0:raise OSError('Snapshot write made no progress')
       view=view[count:]
     final=os.fstat(source)
     if copied.hexdigest()!=h.hexdigest() or (actual.st_size,actual.st_mtime_ns,actual.st_ctime_ns)!=(final.st_size,final.st_mtime_ns,final.st_ctime_ns):raise ValueError('Snapshot input changed')
     os.fsync(out);os.fchmod(out,0o400);os.replace(temporary,target)
    entries.append(dict(path=relative,type='file',hash=h.hexdigest(),size=size,mode=0o700 if actual.st_mode&0o111 else 0o600,mtimeNs=str(actual.st_mtime_ns)))
   finally:
    os.close(source)
    if out is not None:os.close(out)
    if temporary and os.path.exists(temporary):os.unlink(temporary)
  else:raise ValueError('Special files cannot enter a snapshot')
fd=os.open(root,flags|os.O_DIRECTORY)
try:walk(fd)
finally:os.close(fd)
print(json.dumps(dict(version=1,kind=kind,entries=entries),separators=(',',':'),ensure_ascii=True))
`

export async function captureTree(
  store,
  root,
  { kind = 'source', ignoreLake = false, signal } = {},
) {
  signal?.throwIfAborted()
  const { stdout } = await execute(
    'python3',
    [
      '-I',
      '-c',
      captureScript,
      root,
      store.objects,
      kind,
      ignoreLake ? '1' : '0',
      String(store.reserveBytes),
      store.budget.filename,
      String(store.maxBytes),
      String(store.maxFiles),
      String(manifestLimits(kind).entries),
    ],
    { signal, maxBuffer: manifestLimits(kind).bytes, timeout: 30 * 60 * 1000 },
  )
  const manifest = validateManifest(JSON.parse(stdout))
  await syncDirectory(store.objects)
  const sealed = await store.seal(manifest.entries, kind)
  return { ...sealed, manifest }
}

export function snapshotDirectory(base, id) {
  return path.join(base, identifier(id, 'snapshot identifier'))
}
