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
const chatSuites = [
  'auth-recovery',
  'provider-settings',
  'model-options',
  'chat-naming',
  'rcp-queue',
  'chat',
  'streaming',
  'ask-search',
  'markdown-security',
  'chat-readability',
  'chat-compact',
  'reasoning',
  'reasoning-timeline',
  'reasoning-history',
  'autosave',
  'lean-cache',
  'chat-recovery',
  'chat-focus-picker',
  'proof-chat',
  'proof-focus-recovery',
  'current-file',
  'formalize-documents',
  'evaluation-recovery',
  'settings-recovery',
]
const workspaceSuites = [
  'account-controls',
  'file-lifecycle',
  'books',
  'downloads',
  'tex',
  'terminal',
  'search-results',
  'import',
  'import-environment',
  'private-import',
  'import-publishing',
  'git',
  'git-connections',
  'file-creation',
  'file-tree',
  'dependency-files',
  'definition-project-scope',
  'editor-focus',
  'help-tips',
  'lean-oversize',
  'markdown-files',
  'setup-progress',
  'setup-recovery',
  'sidebar',
  'single-file',
  'source-navigation',
  'trash-delete-all',
  'trash-processes',
  'workspace-switch',
]
const suites = [...chatSuites, ...workspaceSuites]
const groups = { chat: chatSuites, workspace: workspaceSuites }
const args = process.argv.slice(2)
const group =
  args.length === 1 && args[0].startsWith('--group=')
    ? args[0].slice('--group='.length)
    : null
const selected = group === null ? args : groups[group]
try {
  if (!selected) throw new Error(`Unknown browser group: ${group}`)
  for (const suite of selected)
    if (!suites.includes(suite))
      throw new Error(`Unknown browser suite: ${suite}`)
  for (const suite of selected.length ? selected : suites) {
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
