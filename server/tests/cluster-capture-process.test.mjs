import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { captureProcess } from '../cluster/capture-process.mjs'

test('cancelled capture waits for actual helper shutdown before releasing its lane', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lf-capture-close-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ready = path.join(directory, 'ready')
  const stopped = path.join(directory, 'stopped')
  const controller = new AbortController()
  const task = captureProcess(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs')
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(process.argv[2], 'stopped')
      process.exit(0)
    }, 60))
    fs.writeFileSync(process.argv[1], 'ready')
    setInterval(() => {}, 1000)
  `,
      ready,
      stopped,
    ],
    { signal: controller.signal, timeout: 5000 },
  )
  const rejected = assert.rejects(task, { name: 'AbortError' })
  const deadline = Date.now() + 3000
  while (!(await fs.stat(ready).catch(() => null)) && Date.now() < deadline)
    await delay(10)
  controller.abort()
  await rejected
  assert.equal(await fs.readFile(stopped, 'utf8'), 'stopped')
})

test('capture helper spawn failures reject without waiting for a missing process', async () => {
  await assert.rejects(
    captureProcess('/leanflow-missing-fixture-command', []),
    { code: 'ENOENT' },
  )
})
