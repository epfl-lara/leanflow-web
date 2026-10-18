import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { LeanCheckSupport } from '../lean-check.mjs'
import { sourceFingerprint } from '../source-fingerprint.mjs'
import { EventStore, JobManager } from '../events.mjs'

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-kernel-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('checker support is discovered once per exact toolchain installation and never inferred from check-build', async (t) => {
  const root = await directory(t),
    calls = []
  const versions = ['leanprover/lean4:v4.34.1', 'leanprover/lean4:v4.35.0-rc4']
  const installations = versions.map((_, i) => path.join(root, 'toolchain' + i))
  for (const installation of installations) {
    await fs.mkdir(path.join(installation, 'bin'), { recursive: true })
    await fs.writeFile(path.join(installation, 'bin/lake'), 'fixture')
  }
  await fs.writeFile(path.join(root, 'lean-toolchain'), versions[0])
  const runtime = {
    imageId: 'image-one',
    toolchains: new Map(versions.map((v, i) => [v, installations[i]])),
    async run(root, args, options) {
      calls.push({ args, options })
      return {
        code: 0,
        stdout:
          '  check-build check targets\n  check-test check tests\n' +
          (calls.length > 1 ? '  check check this project\n' : ''),
        stderr: '',
      }
    },
  }
  const support = new LeanCheckSupport(runtime)
  assert.equal(await support.supported(root), false)
  assert.equal(await support.supported(root), false)
  assert.equal(calls.length, 1)
  await fs.writeFile(path.join(root, 'lean-toolchain'), versions[1])
  assert.deepEqual(
    await Promise.all([support.supported(root), support.supported(root)]),
    [true, true],
  )
  assert.equal(calls.length, 2)
  await fs.writeFile(path.join(installations[1], 'bin/lake.new'), 'changed')
  await fs.rename(
    path.join(installations[1], 'bin/lake.new'),
    path.join(installations[1], 'bin/lake'),
  )
  assert.equal(await support.supported(root), true)
  runtime.imageId = 'image-two'
  assert.equal(await support.supported(root), true)
  assert.equal(calls.length, 4)
  assert(
    calls.every(
      ({ args, options }) =>
        /^\/opt\/lean-toolchains\/leanprover--lean4---v4\.(34\.1|35\.0-rc4)\/bin\/lake$/.test(
          args[0],
        ) &&
        args[1] === '--help' &&
        options.network === 'none' &&
        options.readOnlyWorkspace &&
        options.freshHome,
    ),
  )
})

test('failed and cancelled capability discovery cannot downgrade a project or poison the cache', async (t) => {
  const root = await directory(t)
  await fs.mkdir(path.join(root, 'bin'))
  await fs.writeFile(path.join(root, 'bin/lake'), 'fixture')
  await fs.writeFile(path.join(root, 'lean-toolchain'), 'fixture')
  let calls = 0
  const support = new LeanCheckSupport({
    imageId: 'one',
    toolchains: new Map([['fixture', root]]),
    async run() {
      return ++calls === 1
        ? { code: 124, stdout: '' }
        : { code: 0, stdout: 'check  independent checker' }
    },
  })
  await assert.rejects(() => support.supported(root), /Could not identify/)
  assert.equal(await support.supported(root), true)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(
    () => support.supported(root, { signal: controller.signal }),
    /cancelled/,
  )
  assert.equal(calls, 2)
})

async function checkFixture(
  t,
  {
    supported = true,
    result = { code: 0, stdout: 'checked', stderr: '' },
    changed = false,
    changedDuringProbe = false,
    kind = 'project',
    file,
  } = {},
) {
  const base = await directory(t),
    root = path.join(base, 'project'),
    events = new EventStore(base),
    calls = []
  await fs.mkdir(root)
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'theorem example_one : True := by trivial\n',
  )
  const manager = new JobManager({
    events,
    workspaces: {
      get: () => ({ root, status: 'ready', kind }),
      readFile: async () => {},
      checkFingerprint: () => sourceFingerprint(root),
    },
    runtime: {
      leanCheckSupported: async () => {
        if (changedDuringProbe)
          await fs.writeFile(path.join(root, 'lean-toolchain'), 'changed')
        return supported
      },
      async run(root, args, options) {
        calls.push({ args, options })
        if (changed) await fs.writeFile(path.join(root, 'Main.lean'), 'changed')
        if (file && args.includes(file))
          return { code: 1, stdout: '', stderr: 'selected file error' }
        return result
      },
    },
  })
  t.after(async () => {
    await manager.shutdown()
    events.close()
  })
  const job = manager.check('owner', 'project', file)
  await manager.active.get(job.id)
  return { job: events.get(job.id, 'owner'), calls }
}

test('new projects use lake check once, old releases build, and single-file checks stay lightweight', async (t) => {
  const modern = await checkFixture(t)
  assert.equal(modern.job.status, 'completed')
  assert.equal(modern.job.checkMethod, 'lake-check')
  assert.deepEqual(
    modern.calls.map((c) => c.args),
    [['lake', 'check']],
  )
  assert(
    modern.calls[0].options.kernelCheck && modern.calls[0].options.freshHome,
  )
  for (const config of [{ supported: false }, { kind: 'single-file' }]) {
    const older = await checkFixture(t, config)
    assert.equal(older.job.status, 'completed')
    assert.equal(older.job.checkMethod, 'lake-build')
    assert.deepEqual(older.calls[0].args, ['lake', 'build'])
    assert(!older.calls[0].options.kernelCheck)
  }
})

test('kernel rejections and sandbox failures do not fall back to build-only success', async (t) => {
  for (const result of [
    { code: 1, stdout: '', stderr: 'forbidden axiom sorryAx' },
    { code: 2, stdout: '', stderr: 'sandbox unavailable' },
  ]) {
    const checked = await checkFixture(t, { result })
    assert.equal(checked.job.status, 'failed')
    assert.equal(checked.job.checkMethod, 'lake-check')
    assert.deepEqual(
      checked.calls.map((c) => c.args),
      [['lake', 'check']],
    )
    assert.match(checked.job.error, /independent Lean/)
  }
})

test('full-check resource failures explain export and memory limits without downgrading verification', async (t) => {
  for (const [code, message] of [
    [153, /export exceeded/],
    [137, /memory limit/],
  ]) {
    const checked = await checkFixture(t, {
      result: { code, stdout: '', stderr: '' },
    })
    assert.equal(checked.job.status, 'failed')
    assert.match(checked.job.error, message)
    assert.deepEqual(
      checked.calls.map((c) => c.args),
      [['lake', 'check']],
    )
  }
})

test('selected files outside default targets still compile and changed source cannot receive a successful receipt', async (t) => {
  const selected = await checkFixture(t, { file: 'Selected.lean' })
  assert.equal(selected.job.status, 'failed')
  assert.deepEqual(selected.calls[1].args, [
    'lake',
    'env',
    'lean',
    '--json',
    '-Dwarn.sorry=true',
    'Selected.lean',
  ])
  const changed = await checkFixture(t, { changed: true })
  assert.equal(changed.job.status, 'failed')
  assert.equal(changed.job.result.sourceChanged, true)
  assert.match(changed.job.error, /files changed/)
  const changedToolchain = await checkFixture(t, {
    supported: false,
    changedDuringProbe: true,
  })
  assert.equal(changedToolchain.job.status, 'failed')
  assert.equal(changedToolchain.job.result.sourceChanged, true)
})

test('input fingerprints include auxiliary sources and links but exclude rebuildable cache files', async (t) => {
  const root = await directory(t)
  await fs.writeFile(path.join(root, 'Main.lean'), 'original')
  const before = await sourceFingerprint(root)
  for (const name of ['.lake', '.git']) {
    await fs.mkdir(path.join(root, name))
    await fs.writeFile(path.join(root, name, 'generated'), 'cache')
  }
  assert.equal(await sourceFingerprint(root), before)
  await fs.writeFile(path.join(root, 'input.txt'), 'auxiliary')
  const auxiliary = await sourceFingerprint(root)
  assert.notEqual(auxiliary, before)
  await fs.symlink('input.txt', path.join(root, 'alias'))
  assert.notEqual(await sourceFingerprint(root), auxiliary)
})

test('input scanning rejects a redirected root and never reads through directory links', async (t) => {
  const base = await directory(t),
    root = path.join(base, 'project'),
    other = path.join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(other)
  await fs.writeFile(path.join(root, 'Main.lean'), 'owned source')
  await fs.writeFile(path.join(other, 'private.txt'), 'outside one')
  const alias = path.join(base, 'redirected')
  await fs.symlink(other, alias)
  await assert.rejects(() => sourceFingerprint(alias), /Project inputs/)
  await fs.symlink(other, path.join(root, 'linked-directory'))
  const before = await sourceFingerprint(root)
  await fs.writeFile(path.join(other, 'private.txt'), 'outside two')
  assert.equal(await sourceFingerprint(root), before)
})

test('source scanning preserves cancellation without exposing host diagnostics', async (t) => {
  const root = await directory(t)
  const controller = new AbortController()
  controller.abort(new Error('User stopped checking'))
  await assert.rejects(
    () => sourceFingerprint(root, { signal: controller.signal }),
    /User stopped checking/,
  )
  await assert.rejects(
    () => sourceFingerprint(path.join(root, 'missing')),
    /^Error: Project inputs/,
  )
})
