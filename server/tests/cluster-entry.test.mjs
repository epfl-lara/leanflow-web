import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { bridgeNode } from '../cluster/node.mjs'

const execute = promisify(execFile)

test('the worker entry point executes through a deployment symlink', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-entry-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const target = fileURLToPath(new URL('../cluster/node.mjs', import.meta.url))
  const link = path.join(directory, 'node.mjs')
  await fs.symlink(target, link)
  await assert.rejects(
    execute(process.execPath, [link]),
    (error) => error.code === 1 && /Usage: node/.test(error.stderr),
  )
})

test('the forced bridge rejects an SSH shell command before opening a socket', async () => {
  const previous = process.env.SSH_ORIGINAL_COMMAND
  process.env.SSH_ORIGINAL_COMMAND = 'cat /etc/passwd'
  try {
    await assert.rejects(
      bridgeNode({ socketPath: '/does-not-exist' }),
      /Only the LeanFlow worker protocol/,
    )
  } finally {
    if (previous === undefined) delete process.env.SSH_ORIGINAL_COMMAND
    else process.env.SSH_ORIGINAL_COMMAND = previous
  }
})
