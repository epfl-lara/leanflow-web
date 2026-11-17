#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth } from '../server/auth.mjs'

const query = process.argv.slice(2).join(' ').trim()
if (!query)
  throw new Error(
    'Usage: node scripts/remove-user.mjs "Collaborator name or ID"',
  )
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = process.env.STUDIO_DATA_DIR || path.join(project, '.data')
await fs.access(path.join(data, 'auth/users.json'))
const auth = new Auth(data)
const user = await auth.removeUser(query)
console.log(
  `Revoked access for ${user.name}. Project files and history are retained.`,
)
