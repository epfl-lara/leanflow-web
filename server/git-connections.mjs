import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { lookup } from 'node:dns/promises'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { validateGitCredentials } from './git-credentials.mjs'

const locks = new Map()
const providers = new Set(['github', 'gitlab', 'other'])
const emptyIdentity = () => ({ name: '', email: '' })
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const unavailable = () =>
  fail(
    'Saved Git connections could not be read. Ask the server administrator to restore the connection storage.',
    409,
  )

async function locked(key, operation) {
  const previous = locks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => {
    release = resolve
  })
  locks.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

function ownerHash(owner) {
  if (
    typeof owner !== 'string' ||
    !owner.length ||
    owner.length > 200 ||
    /[\x00-\x1f\x7f]/.test(owner)
  )
    fail('A signed-in account is required.', 401)
  return createHash('sha256').update(owner).digest('hex')
}

function parsedHost(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 2048 ||
    /[\x00-\x20\\]/.test(value.trim()) ||
    !/^(?:https:\/\/)?[^/?#]+\/?$/i.test(value.trim())
  )
    fail('Enter a Git host such as github.com or gitlab.com.')
  let url
  try {
    url = new URL(
      value.includes('://') ? value.trim() : `https://${value.trim()}`,
    )
  } catch {
    fail('Enter a Git host such as github.com or gitlab.com.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    fail('Use an HTTPS Git host without a path, credentials, or custom port.')
  return url.hostname
}

function repositoryHost(value) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\x00-\x20\\]/.test(value)
  )
    fail('Enter an HTTPS Git repository URL.')
  let url
  try {
    url = new URL(value)
  } catch {
    fail('Enter an HTTPS Git repository URL.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname === '/'
  )
    fail(
      'Use an HTTPS repository URL without credentials, query parameters, or a custom port.',
    )
  return url.hostname
}

function identity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('Enter a Git author name and email.')
  const { name, email } = value
  if (
    typeof name !== 'string' ||
    typeof email !== 'string' ||
    name.length > 200 ||
    email.length > 254 ||
    /[\x00-\x1f\x7f<>]/.test(name + email)
  )
    fail('Enter a valid Git author name and email.')
  const clean = { name: name.trim(), email: email.trim() }
  if (!clean.name && !clean.email) return clean
  if (!clean.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email))
    fail('Enter both a Git author name and a valid email.')
  return clean
}

function metadata(record) {
  return {
    connections: record.connections.map(
      ({ host, provider, username, updatedAt }) => ({
        host,
        provider,
        username,
        updatedAt,
      }),
    ),
    identity: { ...record.identity },
  }
}

async function privateFile(filename) {
  const file = await fs
    .open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error) => {
      if (error.code === 'ENOENT') throw error
      unavailable()
    })
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > 512_000
    )
      unavailable()
    return await file.readFile()
  } finally {
    await file.close()
  }
}

// Account credentials stay outside project directories and worker mounts. Only
// callers that explicitly perform a Git operation receive a decrypted copy.
export class GitConnections {
  constructor({ dataDir, validateRepository, resolveHost = lookup }) {
    if (typeof validateRepository !== 'function')
      throw new TypeError('Git connections require repository validation.')
    this.dataDir = path.resolve(dataDir)
    this.dir = path.join(this.dataDir, 'git-connections')
    this.validateRepository = validateRepository
    this.resolveHost = resolveHost
    this.ready = null
  }

  async init() {
    if (!this.ready) {
      this.ready = locked(this.dir, async () => {
        await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
        if ((await fs.realpath(this.dataDir)) !== this.dataDir) unavailable()
        await fs.mkdir(this.dir, { mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error
        })
        await this.assertDirectory()
        const keyFile = path.join(this.dir, 'encryption.key')
        try {
          const key = await privateFile(keyFile)
          if (key.length !== 32) unavailable()
          key.fill(0)
        } catch (error) {
          if (error.code !== 'ENOENT') unavailable()
          if (
            (await fs.readdir(this.dir)).some((name) => name.endsWith('.json'))
          )
            unavailable()
          const key = randomBytes(32)
          try {
            await this.writeAtomic(keyFile, key, false)
          } finally {
            key.fill(0)
          }
        }
      })
    }
    await this.ready
    return this
  }

  async assertDirectory() {
    const stat = await fs.lstat(this.dir).catch(unavailable)
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (await fs.realpath(this.dir)) !== this.dir
    )
      unavailable()
  }

  async validatedHost(value) {
    const host = parsedHost(value)
    await this.validateRepository(
      `https://${host}/leanflow-connection-validation.git`,
      this.resolveHost,
    )
    return host
  }

  async writeAtomic(filename, content, replace = true) {
    const temporary = path.join(
      this.dir,
      `.${randomBytes(16).toString('hex')}.tmp`,
    )
    const file = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    try {
      try {
        await file.chmod(0o600)
        await file.writeFile(content)
        await file.sync()
      } finally {
        await file.close()
      }
      await this.assertDirectory()
      if (replace) {
        // Reject links before replacing a record; rename never follows the
        // destination, even if another process changes it after this check.
        await privateFile(filename).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        await fs.rename(temporary, filename)
      } else {
        await fs.link(temporary, filename).catch((error) => {
          if (error.code !== 'EEXIST') throw error
        })
      }
      const directory = await fs.open(
        this.dir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  async readKey() {
    const key = await privateFile(path.join(this.dir, 'encryption.key')).catch(
      unavailable,
    )
    if (key.length !== 32) {
      key.fill(0)
      unavailable()
    }
    return key
  }

  async readRecord(owner) {
    await this.assertDirectory()
    const hash = ownerHash(owner)
    let envelope
    try {
      envelope = await privateFile(path.join(this.dir, `${hash}.json`))
    } catch (error) {
      if (error.code === 'ENOENT')
        return { connections: [], identity: emptyIdentity() }
      unavailable()
    }
    const key = await this.readKey()
    try {
      if (key.length !== 32) unavailable()
      const parsed = JSON.parse(envelope.toString('utf8'))
      if (
        parsed.version !== 1 ||
        !/^[a-f0-9]{24}$/.test(parsed.iv) ||
        !/^[a-f0-9]{32}$/.test(parsed.tag) ||
        typeof parsed.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          parsed.data,
        )
      )
        unavailable()
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(parsed.iv, 'hex'),
      )
      decipher.setAAD(Buffer.from(`LeanFlow Git connections/v1/${hash}`))
      decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
      ])
      let record
      try {
        record = JSON.parse(plaintext.toString('utf8'))
      } finally {
        plaintext.fill(0)
      }
      if (
        !record ||
        record.owner !== owner ||
        !Array.isArray(record.connections) ||
        record.connections.length > 8 ||
        new Set(record.connections.map((item) => item.host)).size !==
          record.connections.length
      )
        unavailable()
      record.identity = identity(record.identity)
      for (const connection of record.connections) {
        if (
          !connection ||
          parsedHost(connection.host) !== connection.host ||
          !providers.has(connection.provider) ||
          !connection.token ||
          typeof connection.username !== 'string' ||
          typeof connection.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(connection.updatedAt))
        )
          unavailable()
        validateGitCredentials(connection)
      }
      return record
    } catch {
      unavailable()
    } finally {
      key.fill(0)
    }
  }

  async writeRecord(owner, record) {
    await this.assertDirectory()
    const hash = ownerHash(owner)
    const key = await this.readKey()
    try {
      if (key.length !== 32) unavailable()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(`LeanFlow Git connections/v1/${hash}`))
      const plaintext = Buffer.from(JSON.stringify({ ...record, owner }))
      let data
      try {
        data = Buffer.concat([cipher.update(plaintext), cipher.final()])
      } finally {
        plaintext.fill(0)
      }
      await this.writeAtomic(
        path.join(this.dir, `${hash}.json`),
        JSON.stringify({
          version: 1,
          iv: iv.toString('hex'),
          tag: cipher.getAuthTag().toString('hex'),
          data: data.toString('base64'),
        }),
      )
    } finally {
      key.fill(0)
    }
  }

  async get(owner) {
    await this.init()
    return await locked(`${this.dir}/${ownerHash(owner)}`, async () =>
      metadata(await this.readRecord(owner)),
    )
  }

  async connect(owner, input) {
    await this.init()
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('Enter a Git host and repository token.')
    const host = await this.validatedHost(input.host)
    const provider =
      input.provider ||
      (host === 'github.com'
        ? 'github'
        : host === 'gitlab.com'
          ? 'gitlab'
          : 'other')
    if (
      !providers.has(provider) ||
      (host === 'github.com' && provider !== 'github') ||
      (host === 'gitlab.com' && provider !== 'gitlab')
    )
      fail('Choose the matching Git provider for this host.')
    const credentials = validateGitCredentials({
      token: input.token,
      username:
        input.username === undefined
          ? provider === 'gitlab'
            ? 'oauth2'
            : 'x-access-token'
          : input.username,
    })
    if (!credentials.token)
      fail('Enter a repository token to connect this host.')
    try {
      return await locked(`${this.dir}/${ownerHash(owner)}`, async () => {
        const record = await this.readRecord(owner)
        const existing = record.connections.findIndex(
          (item) => item.host === host,
        )
        if (existing < 0 && record.connections.length >= 8)
          fail(
            'You can connect up to eight Git hosts. Disconnect one before adding another.',
          )
        const connection = {
          host,
          provider,
          ...credentials,
          updatedAt: new Date().toISOString(),
        }
        if (existing < 0) record.connections.push(connection)
        else record.connections[existing] = connection
        await this.writeRecord(owner, record)
        return metadata(record)
      })
    } finally {
      credentials.token = ''
    }
  }

  async disconnect(owner, host) {
    await this.init()
    const normalized = parsedHost(host)
    return await locked(`${this.dir}/${ownerHash(owner)}`, async () => {
      const record = await this.readRecord(owner)
      record.connections = record.connections.filter(
        (item) => item.host !== normalized,
      )
      await this.writeRecord(owner, record)
      return metadata(record)
    })
  }

  async setIdentity(owner, input) {
    await this.init()
    const clean = identity(input)
    return await locked(`${this.dir}/${ownerHash(owner)}`, async () => {
      const record = await this.readRecord(owner)
      record.identity = clean
      await this.writeRecord(owner, record)
      return metadata(record)
    })
  }

  async credentials(owner, repositoryUrl) {
    await this.init()
    const host = repositoryHost(repositoryUrl)
    return await locked(`${this.dir}/${ownerHash(owner)}`, async () => {
      const record = await this.readRecord(owner)
      const connection = record.connections.find((item) => item.host === host)
      if (!connection) return null
      await this.validateRepository(repositoryUrl, this.resolveHost)
      return { token: connection.token, username: connection.username }
    })
  }
}
