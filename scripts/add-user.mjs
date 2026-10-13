#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const name = args[0]?.trim()
if (!name || name.length > 80 || !/^[\p{L}\p{N} ._-]+$/u.test(name)) throw new Error('Usage: node scripts/add-user.mjs "Collaborator name"')
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || path.join(projectDir, '.data'))
const authDir = path.join(dataDir, 'auth')
await fs.mkdir(authDir, { recursive: true, mode: 0o700 })
const filename = path.join(authDir, 'users.json')
let users
try { users = JSON.parse(await fs.readFile(filename, 'utf8')) } catch (error) {
  if (error.code !== 'ENOENT') throw error
  throw new Error('Start the server first so its owner account is initialized')
}
if (!Array.isArray(users)) throw new Error('Invalid users.json format')
if (users.some(user => user.name.toLowerCase() === name.toLowerCase())) throw new Error('That collaborator name already exists')
const token = randomBytes(32).toString('base64url')
const id = randomBytes(12).toString('hex')
users.push({ id, name, tokenHash: createHash('sha256').update(token).digest('hex') })
const temp = `${filename}.${process.pid}.tmp`
await fs.writeFile(temp, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 })
await fs.rename(temp, filename)
console.log(`Added ${name}. Send this sign-in token privately; it is shown only once:\n${token}`)
