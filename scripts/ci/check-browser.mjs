#!/usr/bin/env node
// Serve only the built client; every API and Lean connection is a closed fixture.
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import express from 'express'

const root = fileURLToPath(new URL('../../', import.meta.url))
await access(path.join(root, 'client/dist/index.html'))
const app = express()
app.use(express.static(path.join(root, 'client/dist')))
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const execute = promisify(execFile)
const suites = [
  'auth-recovery',
  'provider-settings',
  'model-options',
  'chat-naming',
  'chat',
  'streaming',
  'ask-search',
  'markdown-security',
]
try {
  for (const suite of suites) {
    console.log(`Checking ${suite}`)
    try {
      const result = await execute(
        process.execPath,
        [`scripts/check-${suite}-ui.mjs`],
        {
          cwd: root,
          env: { ...process.env, STUDIO_TEST_URL: base },
          timeout: 300000,
          maxBuffer: 8 * 1024 * 1024,
        },
      )
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
    } catch (error) {
      process.exitCode = 1
      process.stderr.write(error.stdout || '')
      process.stderr.write(error.stderr || '')
      console.error(`${suite}: ${error.message}`)
    }
  }
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
