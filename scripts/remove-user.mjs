#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const query = process.argv.slice(2).join(' ').trim()
if (!query) throw new Error('Usage: node scripts/remove-user.mjs "Collaborator name or ID"')
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const filename = path.join(process.env.STUDIO_DATA_DIR || path.join(project, '.data'), 'auth/users.json')
const users = JSON.parse(await fs.readFile(filename, 'utf8'))
const user = users.find(item => item.id === query || item.name.toLowerCase() === query.toLowerCase())
if (!user) throw new Error('Collaborator not found.')
if (user.id === 'owner') throw new Error('The owner account cannot be removed with this helper.')
const temporary = `${filename}.${process.pid}.tmp`
await fs.writeFile(temporary, JSON.stringify(users.filter(item => item.id !== user.id), null, 2) + '\n', { mode: 0o600 })
await fs.rename(temporary, filename)
console.log(`Revoked access for ${user.name}. Project files and history are retained.`)
