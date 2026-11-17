import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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

async function scanProject(dataDir) {
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
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  const project = await store.create('alice', {
    name: 'Input deadline',
    preset: 'lean',
  })
  await store.jobs.get(project.id)
  return { store, project }
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
    const shared = await scanProject(dataDir)
    store = shared.store
    const project = shared.project
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

test('25 authorized readers can share a scan; a save and a later verification each require a new read', async (t) => {
  const dataDir = await directory(t)
  const { store, project } = await scanProject(dataDir)
  t.after(() => store.close())
  const actors = Array.from({ length: 25 }, (_, i) => 'participant' + i)
  await Promise.all(
    actors.map((actor) =>
      store.setMember(project.id, 'alice', actor, 'editor'),
    ),
  )
  const file = await store.readFile(project.id, 'alice', 'Main.lean')
  const bin = path.join(dataDir, 'test-tools')
  await fs.mkdir(bin)
  const python = execFileSync(
    'python3',
    ['-I', '-c', 'import sys;print(sys.executable)'],
    { encoding: 'utf8' },
  ).trim()
  const countFile = path.join(bin, 'scan-count'),
    previous = process.env.PATH
  await fs.writeFile(
    path.join(bin, 'python3'),
    [
      '#!/bin/sh',
      'printf "scan\\n" >> "$STUDIO_TEST_SCAN_COUNT"',
      'exec "$STUDIO_TEST_SCAN_PYTHON" "$@"',
    ].join('\n'),
    { mode: 0o700 },
  )
  const oldCount = process.env.STUDIO_TEST_SCAN_COUNT,
    oldPython = process.env.STUDIO_TEST_SCAN_PYTHON
  process.env.PATH = bin + path.delimiter + previous
  process.env.STUDIO_TEST_SCAN_COUNT = countFile
  process.env.STUDIO_TEST_SCAN_PYTHON = python
  t.after(() => {
    process.env.PATH = previous
    if (oldCount === undefined) delete process.env.STUDIO_TEST_SCAN_COUNT
    else process.env.STUDIO_TEST_SCAN_COUNT = oldCount
    if (oldPython === undefined) delete process.env.STUDIO_TEST_SCAN_PYTHON
    else process.env.STUDIO_TEST_SCAN_PYTHON = oldPython
  })
  const first = Promise.all(
    actors.map((actor) => store.checkFingerprint(project.id, actor)),
  )
  const save = store.writeFile(
    project.id,
    'alice',
    'Main.lean',
    file.content + '\n-- changed\n',
    file.hash,
  )
  const second = Promise.all(
    actors.map((actor) => store.checkFingerprint(project.id, actor)),
  )
  const [before, , after] = await Promise.all([first, save, second])
  assert.equal(new Set(before).size, 1)
  assert.equal(new Set(after).size, 1)
  assert.notEqual(before[0], after[0])
  assert.equal(
    (await fs.readFile(countFile, 'utf8')).trim().split('\n').length,
    2,
  )
  assert.equal(await store.checkFingerprint(project.id, actors[0]), after[0])
  await assert.rejects(store.checkFingerprint(project.id, 'outsider'))
  assert.equal(
    (await fs.readFile(countFile, 'utf8')).trim().split('\n').length,
    3,
  )
})
