import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { promises as fs } from 'node:fs'
import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SESSION_IDLE_TIMEOUT_MS = 48 * 3600_000

const hash = (value) => createHash('sha256').update(value).digest('hex')
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function requestBearerToken(request) {
  return (
    /^Bearer ([A-Za-z0-9_-]+)$/.exec(
      request.headers.authorization || '',
    )?.[1] ?? null
  )
}

function accountName(input) {
  const name = typeof input === 'string' ? input.trim() : ''
  if (!name || name.length > 80 || !/^[\p{L}\p{M}\p{N} ._'’\-]+$/u.test(name))
    throw Object.assign(
      new Error(
        'Enter a name of up to 80 characters using letters, numbers, spaces, apostrophes, dots, underscores or hyphens.',
      ),
      { status: 400 },
    )
  return name
}

function entraIdentity(input) {
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.tenantId !== 'string' ||
    !guid.test(input.tenantId) ||
    typeof input.objectId !== 'string' ||
    !guid.test(input.objectId)
  )
    throw Object.assign(
      new Error(
        'EPFL sign-in returned an invalid account. Try signing in again.',
      ),
      { status: 400 },
    )
  return {
    tenantId: input.tenantId.toLowerCase(),
    objectId: input.objectId.toLowerCase(),
    name: accountName(input.name),
  }
}

function matchesEntra(user, identity) {
  return (
    user.entra?.tenantId === identity.tenantId &&
    user.entra?.objectId === identity.objectId
  )
}

function availableAccountName(name, users) {
  const existing = new Set(users.map((user) => user.name.toLowerCase()))
  let candidate = name
  for (let suffix = 2; existing.has(candidate.toLowerCase()); suffix++) {
    const ending = ` ${suffix}`
    candidate = name.slice(0, 80 - ending.length).trimEnd() + ending
  }
  return candidate
}

export class Auth {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'auth')
    this.attempts = new Map()
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const keyFile = path.join(this.dir, 'session.key')
    try {
      this.key = await fs.readFile(keyFile, 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      this.key = randomBytes(32).toString('hex')
      await fs.writeFile(keyFile, this.key, { mode: 0o600, flag: 'wx' })
    }
    const usersFile = path.join(this.dir, 'users.json')
    try {
      this.users = JSON.parse(await fs.readFile(usersFile, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      const token = randomBytes(32).toString('base64url')
      this.users = [
        { id: 'owner', name: 'Owner', role: 'owner', tokenHash: hash(token) },
      ]
      await fs.writeFile(usersFile, JSON.stringify(this.users, null, 2), {
        mode: 0o600,
        flag: 'wx',
      })
      await fs.writeFile(path.join(this.dir, 'owner.token'), token + '\n', {
        mode: 0o600,
        flag: 'wx',
      })
    }
  }
  async refreshUsers() {
    this.users = JSON.parse(
      await fs.readFile(path.join(this.dir, 'users.json'), 'utf8'),
    )
  }
  public(user) {
    return {
      id: user.id,
      name: user.name,
      profileComplete: user.profileComplete === true,
      role:
        user.id === 'owner'
          ? 'owner'
          : user.role === 'admin'
            ? 'admin'
            : 'user',
      ...(user.entra ? { entraLinked: true } : {}),
    }
  }
  requireAdmin(user) {
    if (!['owner', 'admin'].includes(this.public(user).role))
      throw Object.assign(new Error('Administrator access is required.'), {
        status: 403,
      })
  }
  async createUser(actor, input) {
    return this.mutate(async () => {
      const current = this.users.find((user) => user.id === actor.id)
      if (!current)
        throw Object.assign(new Error('Sign in again.'), { status: 401 })
      this.requireAdmin(current)
      const name = accountName(input?.name),
        role = input?.role || 'user'
      if (!['admin', 'user'].includes(role))
        throw Object.assign(new Error('Choose admin or user.'), { status: 400 })
      if (role === 'admin' && this.public(current).role !== 'owner')
        throw Object.assign(
          new Error('Only the owner can appoint administrators.'),
          { status: 403 },
        )
      if (
        this.users.some(
          (user) => user.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw Object.assign(
          new Error('An account with that name already exists.'),
          { status: 409 },
        )
      const token = randomBytes(32).toString('base64url')
      const user = {
        id: randomBytes(12).toString('hex'),
        name,
        role,
        tokenHash: hash(token),
      }
      this.users.push(user)
      return { user: this.public(user), token }
    })
  }
  async signInEntra(identity, { allowSignup = false, expectedUserId } = {}) {
    const verified = entraIdentity(identity)
    return this.mutate(() => {
      const user = this.users.find((current) => matchesEntra(current, verified))
      if (expectedUserId !== undefined && user?.id !== expectedUserId)
        throw Object.assign(
          new Error(
            'This EPFL sign-in does not match the account you have open. Sign in with its linked EPFL account or access token.',
          ),
          { status: 409 },
        )
      if (user) return user
      if (allowSignup !== true)
        throw Object.assign(
          new Error(
            'This EPFL account is not linked to LeanFlow. Sign in with your access token to link it, or ask the administrator for access.',
          ),
          { status: 403 },
        )
      const created = {
        id: randomBytes(12).toString('hex'),
        name: availableAccountName(verified.name, this.users),
        role: 'user',
        entra: { tenantId: verified.tenantId, objectId: verified.objectId },
      }
      this.users.push(created)
      return created
    })
  }
  async linkEntra(actor, identity) {
    const verified = entraIdentity(identity)
    return this.mutate(() => {
      const current = this.users.find((user) => user.id === actor?.id)
      if (!current)
        throw Object.assign(new Error('Sign in again before linking EPFL.'), {
          status: 401,
        })
      if (
        this.users.some(
          (user) => user.id !== current.id && matchesEntra(user, verified),
        )
      )
        throw Object.assign(
          new Error(
            'This EPFL account is already linked to another LeanFlow account. Ask the administrator for help.',
          ),
          { status: 409 },
        )
      if (current.entra && !matchesEntra(current, verified))
        throw Object.assign(
          new Error(
            'Your LeanFlow account is already linked to a different EPFL account. Sign in with that account or ask the administrator for help.',
          ),
          { status: 409 },
        )
      current.entra = {
        tenantId: verified.tenantId,
        objectId: verified.objectId,
      }
      return current
    })
  }
  async updateProfile(actor, input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'name')
    )
      throw Object.assign(new Error('Send only the name you want to use.'), {
        status: 400,
      })
    const name = accountName(input.name)
    return this.mutate(() => {
      const current = this.users.find((user) => user.id === actor.id)
      if (!current)
        throw Object.assign(new Error('Sign in again.'), { status: 401 })
      if (
        this.users.some(
          (user) =>
            user.id !== current.id &&
            user.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw Object.assign(
          new Error(
            'An account with that name already exists. Choose another name.',
          ),
          { status: 409 },
        )
      current.name = name
      current.profileComplete = true
      return { user: this.public(current) }
    })
  }
  async mutate(change) {
    const task = (this.writeQueue || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.refreshUsers()
        const result = await change()
        const filename = path.join(this.dir, 'users.json'),
          temporary = filename + '.' + randomBytes(12).toString('hex') + '.tmp'
        try {
          await fs.writeFile(
            temporary,
            JSON.stringify(this.users, null, 2) + '\n',
            { mode: 0o600, flag: 'wx' },
          )
          await fs.rename(temporary, filename)
        } finally {
          await fs.rm(temporary, { force: true })
        }
        return result
      })
    this.writeQueue = task
    return task
  }
  #readCurrentUsers() {
    try {
      const filename = path.join(this.dir, 'users.json')
      const stamp = (stat) =>
        `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      if (this.usersStamp !== stamp(statSync(filename, { bigint: true }))) {
        // Permission changes can replace a file without changing its size or
        // mtime. Fingerprint the same descriptor we read, as for dependencies.
        const fd = openSync(filename, 'r')
        try {
          const loadedStamp = stamp(fstatSync(fd, { bigint: true }))
          const users = JSON.parse(readFileSync(fd, 'utf8'))
          if (!Array.isArray(users)) return false
          this.users = users
          this.usersStamp = loadedStamp
        } finally {
          closeSync(fd)
        }
      }
    } catch {
      return false
    }
    return true
  }
  isActive(id) {
    return this.#readCurrentUsers() && this.users.some((user) => user.id === id)
  }
  identify(req) {
    if (!this.#readCurrentUsers()) return null
    const bearer = requestBearerToken(req)
    if (bearer)
      return (
        this.users.find((user) => equal(user.tokenHash, hash(bearer))) || null
      )
    const cookie = /(?:^|;\s*)lemex_web=([^;]+)/.exec(
      req.headers.cookie || '',
    )?.[1]
    if (!cookie) return null
    const [payload, signature] = cookie.split('.')
    if (!payload || !signature || !equal(signature, this.sign(payload)))
      return null
    try {
      const { id, expires } = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      )
      if (!Number.isSafeInteger(expires) || expires <= Date.now()) return null
      return this.users.find((user) => user.id === id) || null
    } catch {
      return null
    }
  }
  sign(payload) {
    return createHmac('sha256', this.key).update(payload).digest('base64url')
  }
  cookie(user, secure = false) {
    const payload = Buffer.from(
      JSON.stringify({
        id: user.id,
        expires: Date.now() + SESSION_IDLE_TIMEOUT_MS,
        nonce: randomBytes(16).toString('hex'),
      }),
    ).toString('base64url')
    return `lemex_web=${payload}.${this.sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_IDLE_TIMEOUT_MS / 1000}${secure ? '; Secure' : ''}`
  }
  async login(token, ip) {
    await this.refreshUsers()
    const user =
      typeof token === 'string' && token.length < 200
        ? this.users.find((it) => equal(it.tokenHash, hash(token.trim())))
        : null
    // A shared SSH/reverse-proxy address must not let invalid attempts lock out
    // collaborators who already have the correct high-entropy access token.
    if (user) {
      this.attempts.delete(ip)
      return user
    }
    const now = Date.now()
    const previous = this.attempts.get(ip)
    const counter =
      previous && now - previous.start < 300_000
        ? previous
        : { start: now, count: 0 }
    if (++counter.count > 12)
      throw Object.assign(
        new Error('Too many sign-in attempts. Try again in five minutes.'),
        { status: 429 },
      )
    this.attempts.set(ip, counter)
    if (this.attempts.size > 1000)
      for (const [key, value] of this.attempts)
        if (now - value.start > 300_000) this.attempts.delete(key)
    while (this.attempts.size > 1000)
      this.attempts.delete(this.attempts.keys().next().value)
    throw Object.assign(new Error('That access token was not recognized.'), {
      status: 401,
    })
  }
}

export function sameOrigin(req, publicOrigin) {
  const origin = req.headers.origin
  if (!origin) return true // Non-browser clients; browser writes also require JSON content type.
  try {
    const expected = publicOrigin || `http://${req.headers.host}`
    return new URL(origin).origin === new URL(expected).origin
  } catch {
    return false
  }
}
