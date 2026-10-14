import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

const stale = (file) =>
  Object.assign(
    new Error(
      `${file} needs an up-to-date Lean index. Use Check Project, then rename again.`,
    ),
    { code: -32803 },
  )
const stamp = (stat) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`

// Read only this project's private build output. Never follow user-controlled
// links into shared dependencies, other projects, or host files.
async function checked(root, relative) {
  if (
    path.isAbsolute(relative) ||
    relative
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.includes('\\'))
  )
    throw stale('The project')
  if ((await fs.realpath(root)) !== path.resolve(root))
    throw stale('The project')
  let file = root
  for (const part of relative.split('/')) {
    file = path.join(file, part)
    const stat = await fs.lstat(file, { bigint: true })
    if (stat.isSymbolicLink()) throw stale('The project')
  }
  return file
}
async function metadata(root, relative) {
  const file = await checked(root, relative)
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== file)
      throw stale('The project')
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) throw stale('The project')
    return { stat, file }
  } finally {
    await handle.close()
  }
}
async function traceSources(root, relative) {
  const file = await checked(root, relative)
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    if (
      (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== file ||
      (await handle.stat()).size > 2 * 1024 * 1024
    )
      throw stale('The project')
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const read = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      )
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    if (bytesRead > 2 * 1024 * 1024) throw stale('The project')
    const inputs = JSON.parse(bytes.subarray(0, bytesRead).toString()).inputs
    const result = [],
      queue = [inputs]
    while (queue.length) {
      const value = queue.pop()
      if (!Array.isArray(value)) continue
      for (const child of value) {
        if (Array.isArray(child)) queue.push(child)
        else if (typeof child === 'string') {
          const relative = child.startsWith('/workspace/')
            ? child.slice(11)
            : child.startsWith(root + '/')
              ? child.slice(root.length + 1)
              : null
          if (relative?.endsWith('.lean')) result.push(relative)
        }
      }
    }
    return result
  } finally {
    await handle.close()
  }
}

export class LeanProjectIndex {
  constructor({ root, files }) {
    this.root = root
    this.files = files
    this.observed = new Map()
    this.traces = new Map()
  }
  async capture(openUris, cancelled = () => false) {
    let listed = []
    const snapshots = async () => {
      listed = await this.files()
      const entries = listed.filter(
        (f) =>
          f.path.endsWith('.lean') &&
          !f.path.startsWith('.lake/') &&
          path.basename(f.path) !== 'lakefile.lean',
      )
      if (entries.length > 10000) throw stale('This large project')
      const result = new Map()
      for (const { path: name } of entries) {
        if (cancelled()) throw stale('The cancelled rename')
        result.set(name, await metadata(this.root, name))
      }
      return result
    }
    const source = await snapshots(),
      compiled = new Map(),
      indexes = new Map()
    const sourceByBasename = new Map()
    for (const file of source.keys()) {
      const base = path.basename(file),
        entries = sourceByBasename.get(base) ?? []
      entries.push(file)
      sourceByBasename.set(base, entries)
    }
    let visited = 0
    const addIndex = async (name) => {
      if (indexes.size >= 10000) throw stale('This large project')
      const item = await metadata(this.root, name)
      let builtAt = item.stat.mtimeNs
      indexes.set(name, stamp(item.stat))
      let names = [
        name
          .replace(/^\.lake\/build\/lib\/(?:lean\/)?/, '')
          .replace(/\.ilean$/, '.lean'),
      ]
      const trace = name.replace(/\.ilean$/, '.trace')
      try {
        const info = await metadata(this.root, trace),
          key = stamp(info.stat)
        if (info.stat.mtimeNs < builtAt) builtAt = info.stat.mtimeNs
        const cached = this.traces.get(trace)
        const traced =
          cached?.key === key
            ? cached.names
            : await traceSources(this.root, trace)
        if (traced.length) names = traced
        else if (!source.has(names[0])) {
          const matches = (
            sourceByBasename.get(path.basename(names[0])) ?? []
          ).filter((file) => file.endsWith('/' + names[0]))
          if (matches.length === 1) names = matches
        }
        this.traces.set(trace, { key, names })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      for (const name of names) compiled.set(name, builtAt)
    }
    const visit = async (relative) => {
      if (cancelled()) throw stale('The cancelled rename')
      let directory
      try {
        directory = await checked(this.root, relative)
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (cancelled()) throw stale('The cancelled rename')
        if (++visited > 100000) throw stale('This large project')
        if (relative === '.lake' && entry.name === 'packages') continue
        const name = relative + '/' + entry.name
        if (entry.isSymbolicLink()) throw stale('The project')
        if (entry.isDirectory()) await visit(name)
        else if (entry.isFile() && entry.name.endsWith('.ilean')) {
          await addIndex(name)
        }
      }
    }
    await visit('.lake')
    for (const entry of listed)
      if (entry.path.endsWith('.ilean') && !entry.path.startsWith('.lake/'))
        await addIndex(entry.path)
    for (const [file, { stat }] of source) {
      const uri =
        'file:///workspace/' + file.split('/').map(encodeURIComponent).join('/')
      if (
        !openUris.has(uri) &&
        (compiled.get(file) === undefined || stat.mtimeNs > compiled.get(file))
      )
        throw stale(file)
    }
    const changes = []
    for (const [name, value] of indexes)
      if (this.observed.get(name) !== value)
        changes.push({
          uri:
            'file:///workspace/' +
            name.split('/').map(encodeURIComponent).join('/'),
          type: 2,
        })
    for (const name of this.observed.keys())
      if (!indexes.has(name))
        changes.push({
          uri:
            'file:///workspace/' +
            name.split('/').map(encodeURIComponent).join('/'),
          type: 3,
        })
    return {
      changes,
      commit: () => {
        this.observed = indexes
      },
      validate: async () => {
        const latest = await snapshots()
        if (
          latest.size !== source.size ||
          [...source].some(
            ([name, value]) =>
              !latest.has(name) ||
              stamp(latest.get(name).stat) !== stamp(value.stat),
          )
        )
          throw stale('A file that changed during this rename')
      },
    }
  }
}
