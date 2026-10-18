#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth } from '../server/auth.mjs'

const [name, role = 'user', tokenFile] = process.argv.slice(2)
if (!name || !tokenFile)
  throw new Error(
    'Usage: node scripts/add-user.mjs "Collaborator name" user|admin /private/path/account.token',
  )
const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const dataDir = path.resolve(
  process.env.STUDIO_DATA_DIR || path.join(projectDir, '.data'),
)
await fs.access(path.join(dataDir, 'auth/users.json'))
// Reserve the destination before creating the account; never overwrite a token.
const output = await fs.open(tokenFile, 'wx', 0o600)
try {
  const auth = new Auth(dataDir)
  await auth.init()
  const result = await auth.createUser({ id: 'owner' }, { name, role })
  await output.writeFile(result.token + '\n')
  console.log(
    `Added ${result.user.name} (${result.user.role}). Sign-in token saved privately to ${tokenFile}.`,
  )
} finally {
  await output.close()
}
