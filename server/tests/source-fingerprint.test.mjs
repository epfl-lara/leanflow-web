import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sourceFingerprint } from '../source-fingerprint.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-fingerprint-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function sparseInput(root) {
  const filename = path.join(root, 'large-generated.bin')
  const file = await fs.open(filename, 'w')
  try {
    await file.truncate(8 * 1024 ** 3)
  } finally {
    await file.close()
  }
  assert((await fs.stat(filename)).blocks * 512 < 1024 * 1024)
}

test('source fingerprint retains the exact sorted content and symbolic-link digest', async (t) => {
  const root = await directory(t)
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await fs.writeFile(path.join(root, 'Aux.txt'), 'auxiliary input\n')
  await fs.symlink('../private.txt', path.join(root, 'Linked.txt'))
  for (const omitted of ['.git', '.lake']) {
    await fs.mkdir(path.join(root, omitted))
    await fs.writeFile(path.join(root, omitted, 'ignored'), 'generated state')
  }
  const expected = hash(
    JSON.stringify([
      ['Aux.txt', hash('auxiliary input\n')],
      ['Linked.txt', 'link', '../private.txt'],
      ['Main.lean', hash('example : True := by trivial\n')],
    ]),
  )
  assert.equal(await sourceFingerprint(root), expected)
})

test('missing roots and helper spawn failures keep host diagnostics out of errors', async (t) => {
  const root = await directory(t)
  const sanitized = (error) => {
    assert.equal(
      error.message,
      'Project inputs changed or could not be read during checking. Save your files and retry.',
    )
    assert.equal(error.message.includes(root), false)
    return true
  }
  await assert.rejects(sourceFingerprint(path.join(root, 'missing')), sanitized)
  const originalPath = process.env.PATH
  process.env.PATH = root
  try {
    await assert.rejects(sourceFingerprint(root), sanitized)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test(
  'source fingerprint kills a sparse-input scan at its deadline and keeps cancellation reasons',
  { timeout: 5000 },
  async (t) => {
    const root = await directory(t)
    await sparseInput(root)
    const started = Date.now()
    await assert.rejects(sourceFingerprint(root, { timeoutMs: 50 }), {
      status: 408,
      message: /took too long.*Retry.*large generated files/,
    })
    assert(
      Date.now() - started < 2000,
      'The deadline must stop hashing promptly',
    )
    const controller = new AbortController()
    const reason = new Error('Caller stopped the input scan')
    const pending = sourceFingerprint(root, { signal: controller.signal })
    const timer = setTimeout(() => controller.abort(reason), 50)
    try {
      await assert.rejects(pending, (error) => error === reason)
    } finally {
      clearTimeout(timer)
    }
    await fs.unlink(path.join(root, 'large-generated.bin'))
    assert.match(await sourceFingerprint(root), /^[a-f0-9]{64}$/)
  },
)

test(
  'a fingerprint deadline releases the workspace file queue for an ordinary save',
  { timeout: 5000 },
  async (t) => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'source-fingerprint-'),
    )
    let store
    t.after(async () => {
      store?.close()
      await fs.rm(dataDir, { recursive: true, force: true })
    })
    const runtime = {
      templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
      templateRoot: () => null,
      async prepareToolchain() {},
      async run(root, args) {
        if (args[0] === 'lake' && args[1] === 'update')
          await fs.writeFile(
            path.join(root, 'lake-manifest.json'),
            '{"packages":[]}',
          )
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    store = await new WorkspaceStore({ dataDir, runtime }).init()
    const project = await store.create('alice', {
      name: 'Input deadline',
      preset: 'lean',
    })
    await store.jobs.get(project.id)
    const original = await store.readFile(project.id, 'alice', 'Main.lean')
    await sparseInput(project.root)
    const pending = store.checkFingerprint(project.id, 'alice', {
      timeoutMs: 50,
    })
    const started = Date.now()
    const saved = store.writeFile(
      project.id,
      'alice',
      'Main.lean',
      '-- responsive save\n',
      original.hash,
    )
    const checked = assert.rejects(pending, { status: 408 })
    await checked
    await saved
    assert(
      Date.now() - started < 2000,
      'A timed-out scan must release ordinary saves promptly',
    )
    assert.equal(
      (await store.readFile(project.id, 'alice', 'Main.lean')).content,
      '-- responsive save\n',
    )
    assert.equal(store.locks.has(project.id), false)
  },
)
