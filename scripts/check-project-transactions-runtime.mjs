import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { WorkspaceStore } from '../server/workspaces.mjs'

// Real workspace transactions and SQLite, with no Docker, model calls or user data.
const sourceBytes = 7.5 * 1024 * 1024
const source = (character) =>
  '-- fixture\n' + character.repeat(sourceBytes - 11)
const hash = (content) => createHash('sha256').update(content).digest('hex')
const filenames = Array.from({ length: 4 }, (_, index) => `Large${index}.lean`)
const runtime = {
  templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
  templateRoot: () => null,
  prepareToolchain: async () => {},
  async run(root, args) {
    if (args[0] === 'lake' && args.includes('update'))
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[]}',
      )
    return { code: 0, stdout: 'Lean version 4.34.1\n', stderr: '' }
  },
}

async function interrupt(dataDir, projectId) {
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  const changes = []
  const after = source('z')
  for (const filename of filenames) {
    const before = await store.readFile(projectId, 'alice', filename)
    changes.push({ path: filename, beforeHash: before.hash, after })
  }
  const rename = fs.rename
  fs.rename = async (from, to) => {
    await rename(from, to)
    if (String(from).includes('/staged/0')) process.kill(process.pid, 'SIGKILL')
  }
  syncBuiltinESMExports()
  await store.applyChanges(projectId, 'alice', changes)
  throw new Error('The transaction did not reach its interruption point.')
}

async function measure(store, healthy, operation) {
  let previous = performance.now(),
    maxDelayMs = 0,
    ticks = 0
  let reading = null,
    readFailure,
    concurrentReads = 0,
    maxReadMs = 0
  const pulse = setInterval(() => {
    const now = performance.now()
    maxDelayMs = Math.max(maxDelayMs, now - previous - 2)
    previous = now
    ticks++
  }, 2)
  const editor = setInterval(() => {
    if (reading) return
    const started = performance.now()
    reading = store
      .readFile(healthy.id, 'alice', 'Main.lean')
      .then((file) => {
        assert.equal(file.content, '-- concurrent editor\n')
        maxReadMs = Math.max(maxReadMs, performance.now() - started)
        concurrentReads++
      })
      .catch((error) => {
        readFailure = error
      })
      .finally(() => {
        reading = null
      })
  }, 5)
  const started = performance.now()
  try {
    await operation()
    await delay(5)
  } finally {
    clearInterval(pulse)
    clearInterval(editor)
    await reading
  }
  if (readFailure) throw readFailure
  assert(ticks >= 10, 'Other requests must run during a large transaction.')
  assert(
    concurrentReads >= 3,
    'The concurrent editor must keep reading its own project.',
  )
  assert(
    maxDelayMs < 200,
    `A large update blocked the request loop for ${maxDelayMs.toFixed(1)} ms.`,
  )
  assert(
    maxReadMs < 250,
    `The concurrent editor waited ${maxReadMs.toFixed(1)} ms.`,
  )
  return {
    totalMs: performance.now() - started,
    maxDelayMs,
    ticks,
    concurrentReads,
    maxReadMs,
  }
}

async function check() {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-transaction-runtime-'),
  )
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  try {
    const project = await store.create('alice', { preset: 'lean' })
    await store.jobs.get(project.id)
    const healthy = await store.create('alice', { preset: 'lean' })
    await store.jobs.get(healthy.id)
    const initialHealthy = await store.readFile(
      healthy.id,
      'alice',
      'Main.lean',
    )
    await store.writeFile(
      healthy.id,
      'alice',
      'Main.lean',
      '-- concurrent editor\n',
      initialHealthy.hash,
    )
    const before = source('x'),
      after = source('y')
    const changes = []
    for (const filename of filenames) {
      await fs.writeFile(path.join(project.root, filename), before)
      changes.push({ path: filename, beforeHash: hash(before), after })
    }
    const initialWal = (
      await fs.stat(path.join(dataDir, 'workspaces.sqlite-wal'))
    ).size
    const applied = await measure(store, healthy, () =>
      store.applyChanges(project.id, 'alice', changes),
    )
    applied.walGrowthBytes =
      (await fs.stat(path.join(dataDir, 'workspaces.sqlite-wal'))).size -
      initialWal
    assert(
      applied.walGrowthBytes < 2 * 1024 * 1024,
      'Source bytes must not inflate the workspace database.',
    )
    const recoveries = []
    for (const version of [2, 1]) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), '--interrupt', dataDir, project.id],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      assert.equal(result.signal, 'SIGKILL', stderr)
      const row = store.db
        .prepare('SELECT * FROM pending_project_transactions')
        .get()
      const directory = path.join(store.historyDir, project.id, row.id)
      if (version === 1) {
        const intent = JSON.parse(row.payload)
        intent.version = 1
        for (const [index, change] of intent.changes.entries()) {
          change.before = (
            await fs.readFile(path.join(directory, 'originals', String(index)))
          ).toString('base64')
          delete change.beforeSize
          delete change.afterSize
          delete change.beforeMode
        }
        store.db
          .prepare(
            'UPDATE pending_project_transactions SET payload=? WHERE id=?',
          )
          .run(JSON.stringify(intent), row.id)
        await fs.rm(path.join(directory, 'originals'), { recursive: true })
      }
      // Force independent durable-byte fallback, including the old inline format.
      await fs.unlink(path.join(directory, 'before', '0'))
      const recovered = await measure(store, healthy, () =>
        store.retryFileRecovery(project.id, 'alice'),
      )
      assert.equal(
        store.db
          .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
          .get().count,
        0,
      )
      for (const filename of filenames)
        assert.equal(
          (await store.readFile(project.id, 'alice', filename)).hash,
          hash(after),
        )
      recoveries.push({ version, ...recovered })
    }
    console.log(
      JSON.stringify(
        { passed: true, sourceBytes: 4 * sourceBytes, applied, recoveries },
        null,
        2,
      ),
    )
  } finally {
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--interrupt')
  await interrupt(process.argv[3], process.argv[4])
else await check()
