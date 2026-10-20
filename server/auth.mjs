import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { promises as fs } from 'node:fs'
import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
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
      role:
        user.id === 'owner'
          ? 'owner'
          : user.role === 'admin'
            ? 'admin'
            : 'user',
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
      const name = typeof input?.name === 'string' ? input.name.trim() : '',
        role = input?.role || 'user'
      if (
        typeof name !== 'string' ||
        !name ||
        name.length > 80 ||
        !/^[\p{L}\p{N} ._-]+$/u.test(name)
      )
        throw Object.assign(
          new Error('Enter an account name of up to 80 characters.'),
          { status: 400 },
        )
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
  identify(req) {
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
          if (!Array.isArray(users)) return null
          this.users = users
          this.usersStamp = loadedStamp
        } finally {
          closeSync(fd)
        }
      }
    } catch {
      return null
    }
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(
      req.headers.authorization || '',
    )?.[1]
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
      if (!Number.isSafeInteger(expires) || expires < Date.now()) return null
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
        expires: Date.now() + 12 * 3600_000,
        nonce: randomBytes(16).toString('hex'),
      }),
    ).toString('base64url')
    return `lemex_web=${payload}.${this.sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`
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
