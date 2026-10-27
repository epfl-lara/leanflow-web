import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'
import { PROJECT_CHECK_COMMAND } from '../lean-check.mjs'
import { cleanupGitWorkerHome } from '../git-credentials.mjs'

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lemex-runtime-cache-'),
  )
  const dataDir = path.join(directory, 'data')
  const root = path.join(dataDir, 'project')
  const docker = path.join(directory, 'docker-fixture')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.join(dataDir, 'runtime'), { recursive: true })
  await fs.writeFile(
    docker,
    `#!${process.execPath}\nif (process.argv[2] === 'run') console.log(JSON.stringify(process.argv.slice(2)))\n`,
    { mode: 0o700 },
  )
  const runtime = new Runtime({
    dataDir,
    docker,
    kernelExportMaxBytes: 1024 * 1024,
  })
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  t.after(async () => {
    await runtime.shutdown()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { runtime, dataDir, root }
}

const mounts = (argv) =>
  argv.flatMap((value, index) => (value === '--mount' ? [argv[index + 1]] : []))
const cacheOptions = { readOnlyWorkspace: true, writeLakeCache: true }

test('fresh verification homes are removed after success or failure without deleting the persistent home', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const home = await runtime.home(root)
  await fs.writeFile(path.join(home, 'persistent'), 'keep')
  const before = (await fs.readdir(path.join(dataDir, 'runtime/homes'))).sort()
  for (const exit of [0, 1]) {
    await fs.writeFile(
      runtime.docker,
      `#!${process.execPath}\nif(process.argv[2]==='run')process.exit(${exit})\n`,
      { mode: 0o700 },
    )
    assert.equal(
      (await runtime.run(root, ['true'], { freshHome: true })).code,
      exit,
    )
    assert.deepEqual(
      (await fs.readdir(path.join(dataDir, 'runtime/homes'))).sort(),
      before,
    )
    assert.equal(
      await fs.readFile(path.join(home, 'persistent'), 'utf8'),
      'keep',
    )
  }
})

test('export callers can retain only a fresh home until its output has been transferred', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  let child
  await assert.rejects(
    runtime.run(root, ['true'], { retainHome: true }),
    /Only a fresh worker home/,
  )
  await assert.rejects(
    runtime.run(root, ['true'], { freshHome: true, retainHome: 'true' }),
    /must be booleans/,
  )
  const result = await runtime.run(root, ['true'], {
    freshHome: true,
    cleanHome: true,
    retainHome: true,
    onSpawn: (worker) => {
      child = worker
    },
  })
  assert.equal(result.code, 0)
  assert.equal(runtime.children.size, 0)
  assert((await fs.stat(child.workerHome)).isDirectory())
  await cleanupGitWorkerHome(child, dataDir)
  await assert.rejects(fs.stat(child.workerHome), { code: 'ENOENT' })
})

test('nested sandbox permissions apply only to isolated lake check workers', async (t) => {
  const { runtime, root } = await fixture(t)
  runtime.apparmorEnabled = true
  const options = {
    ...cacheOptions,
    kernelCheck: true,
    freshHome: true,
    cleanHome: true,
  }
  for (const [args, overrides] of [
    [['true'], {}],
    [['lake', 'check'], { network: 'bridge' }],
    [['lake', 'check'], { freshHome: false }],
    [['lake', 'check'], { retainHome: true }],
    [['lake', 'check'], { readOnlyWorkspace: false, writeLakeCache: false }],
  ])
    await assert.rejects(
      runtime.run(root, args, { ...options, ...overrides }),
      /Kernel checking requires/,
    )
  const kernel = JSON.parse(
    (await runtime.run(root, ['lake', 'check'], options)).stdout,
  )
  assert(kernel.includes('apparmor=leanflow-kernel-check'))
  assert(kernel.some((arg) => arg.endsWith('deploy/lake-check-seccomp.json')))
  assert(kernel.includes('systempaths=unconfined'))
  assert.equal(kernel[kernel.indexOf('--memory') + 1], '12g')
  assert.equal(kernel[kernel.indexOf('--cpus') + 1], '6')
  assert(kernel.includes('fsize=1048576:1048576'))
  assert(
    mounts(kernel).some((mount) => mount.includes('kernel-check-tmp,dst=/tmp')),
  )
  assert(!kernel.includes('--privileged') && !kernel.includes('--cap-add'))
  const normal = JSON.parse((await runtime.run(root, ['true'])).stdout)
  assert(!normal.includes('apparmor=leanflow-kernel-check'))
  assert(!normal.includes('systempaths=unconfined'))
})

test('project checker mounts only the trusted adapter and forces an offline fresh read-only worker', async (t) => {
  const { runtime, root } = await fixture(t)
  const argv = JSON.parse(
    (await runtime.checkProject(root, { network: 'bridge', freshHome: false }))
      .stdout,
  )
  assert.deepEqual(
    argv.slice(-PROJECT_CHECK_COMMAND.length),
    PROJECT_CHECK_COMMAND,
  )
  assert.equal(argv[argv.indexOf('--network') + 1], 'none')
  assert(
    mounts(argv).some((mount) =>
      mount.endsWith(
        'server/lean-project-check,dst=/opt/leanflow-project-check,readonly',
      ),
    ),
  )
  assert(
    mounts(argv).some((mount) => mount.endsWith('dst=/workspace,readonly')),
  )
  assert(mounts(argv).some((mount) => mount.endsWith('dst=/workspace/.lake')))
  assert(argv.includes('systempaths=unconfined'))
  const options = {
    ...cacheOptions,
    freshHome: true,
    cleanHome: true,
    kernelCheck: true,
  }
  for (const command of [
    [...PROJECT_CHECK_COMMAND, 'extra'],
    ['python3', '-I', '/workspace/.lake/forged.py'],
    ['lake', 'check', '--inadvisably-no-sandbox'],
  ])
    await assert.rejects(
      runtime.run(root, command, options),
      /Kernel checking requires/,
    )
  const normal = JSON.parse(
    (await runtime.run(root, PROJECT_CHECK_COMMAND)).stdout,
  )
  assert(
    !mounts(normal).some((mount) =>
      mount.includes('/opt/leanflow-project-check'),
    ),
  )
  assert(!normal.includes('systempaths=unconfined'))
})

test('full checks share weighted worker capacity and serialize exports while small jobs remain responsive', async (t) => {
  const { runtime, root } = await fixture(t)
  runtime.maxConcurrent = 4
  await fs.writeFile(
    runtime.docker,
    `#!${process.execPath}\nif(process.argv[2]==='run' && !process.argv.includes('quick'))setInterval(()=>{},1000)\n`,
    { mode: 0o700 },
  )
  const first = runtime.spawn(root, ['hold'])
  const second = runtime.spawn(root, ['hold'])
  const options = {
    ...cacheOptions,
    kernelCheck: true,
    freshHome: true,
    cleanHome: true,
  }
  const pending = runtime.spawnWhenAvailable(root, ['lake', 'check'], options)
  assert.equal(runtime.info().queued, 1)
  const editor = runtime.spawn(root, ['hold'])
  first.kill()
  await first.workerStopped
  assert.equal(runtime.info().queued, 1)
  second.kill()
  await second.workerStopped
  const kernel = await pending
  assert.equal(runtime.info().usedSlots, 4)
  assert.equal(kernel.workerSlots, 3)
  const next = runtime.spawnWhenAvailable(root, ['lake', 'check'], options)
  assert.equal(runtime.info().queued, 1)
  editor.kill()
  await editor.workerStopped
  assert.equal(runtime.info().queued, 1, 'Only one export may run at a time')
  assert.equal((await runtime.run(root, ['quick'])).code, 0)
  kernel.kill()
  await kernel.workerStopped
  const resumed = await next
  assert.equal(resumed.kernelCheck, true)
  resumed.kill()
  await resumed.workerStopped
  assert.equal(runtime.info().usedSlots, 0)
})

test('dependency lookups observe replacements, in-place edits and deletion after warming the registry', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const sources = ['source-a', 'source-b'].map((name) =>
    path.join(dataDir, name),
  )
  for (const source of sources) {
    await fs.mkdir(path.join(source, '.lake/packages/mathlib'), {
      recursive: true,
    })
  }
  const filename = path.join(dataDir, 'runtime/dependencies.json')
  const contents = (source) => JSON.stringify({ [root]: source })
  await fs.writeFile(filename, contents(sources[0]))
  assert.equal(runtime.dependencyRoot(root), sources[0])
  const original = await fs.stat(filename)
  await fs.writeFile(filename + '.replacement', contents(sources[1]))
  await fs.utimes(filename + '.replacement', original.atime, original.mtime)
  await fs.rename(filename + '.replacement', filename)
  assert.equal(runtime.dependencyRoot(root), sources[1])
  await fs.writeFile(filename, contents(sources[0]))
  assert.equal(runtime.dependencyRoot(root), sources[0])
  await fs.unlink(filename)
  assert.equal(runtime.dependencyRoot(root), null)
})

test('a warm registry observes bindings written by another runtime and keeps unrelated bindings', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const other = new Runtime({ dataDir, docker: runtime.docker })
  const source = path.join(dataDir, 'source')
  const target = path.join(dataDir, 'other-project')
  await fs.mkdir(path.join(source, '.lake/packages/mathlib'), {
    recursive: true,
  })
  await fs.mkdir(target)
  await runtime.inheritDependencies(source, root)
  assert.equal(runtime.dependencyRoot(root), source)
  await other.inheritDependencies(source, target)
  assert.equal(runtime.dependencyRoot(target), source)
  assert.equal(runtime.dependencyRoot(root), source)
  await other.clearInheritedDependencies(root, { force: true })
  assert.equal(runtime.dependencyRoot(root), null)
  assert.equal(runtime.dependencyRoot(target), source)
})

test('filesystem changes to dependency source roots remain visible with an unchanged registry', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const source = path.join(dataDir, 'source')
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-outside-cache-'),
  )
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(
    path.join(dataDir, 'runtime/dependencies.json'),
    JSON.stringify({ [root]: source }),
  )
  assert.throws(() => runtime.dependencyRoot(root), { code: 'ENOENT' })
  await fs.mkdir(path.join(source, '.lake/packages/mathlib'), {
    recursive: true,
  })
  assert.equal(runtime.dependencyRoot(root), source)
  await fs.rm(source, { recursive: true })
  await fs.symlink(outside, source)
  assert.throws(() => runtime.dependencyRoot(root), /owned data directory/)
  await assert.rejects(runtime.run(root, ['true']), /owned data directory/)
})

for (const link of ['.lake', '.lake/packages']) {
  test(`warm registry lookups and workers still reject a replacement ${link} symlink`, async (t) => {
    const { runtime, root, dataDir } = await fixture(t)
    const source = path.join(dataDir, 'source')
    const privateRoot = path.join(dataDir, 'private-project')
    await fs.mkdir(path.join(source, '.lake/packages/mathlib'), {
      recursive: true,
    })
    await fs.mkdir(path.join(privateRoot, 'packages/mathlib'), {
      recursive: true,
    })
    await runtime.inheritDependencies(source, root)
    assert.equal(runtime.dependencyRoot(root), source)
    await fs.rm(path.join(source, link), { recursive: true })
    await fs.symlink(privateRoot, path.join(source, link))
    assert.throws(
      () => runtime.dependencyRoot(root),
      /real directories inside the selected dependency project/,
    )
    await assert.rejects(
      runtime.run(root, ['true']),
      /real directories inside the selected dependency project/,
    )
  })
}

test('new worker task pools follow the CPU quota and retain an explicit Lean thread setting', async (t) => {
  const { runtime, root } = await fixture(t)
  await fs.writeFile(
    runtime.docker,
    `#!${process.execPath}\nif(process.argv[2]==='run') console.log(JSON.stringify({args:process.argv.slice(2),threads:process.env.LEAN_NUM_THREADS}))\n`,
    { mode: 0o700 },
  )
  runtime.cpus = 2.8
  const normal = JSON.parse((await runtime.run(root, ['true'])).stdout)
  assert.equal(normal.threads, '2')
  assert(normal.args.includes('LEAN_NUM_THREADS'))
  const selected = JSON.parse(
    (await runtime.run(root, ['true'], { env: { LEAN_NUM_THREADS: '1' } }))
      .stdout,
  )
  assert.equal(selected.threads, '1')
  runtime.cpus = 0.5
  assert.equal(
    JSON.parse((await runtime.run(root, ['true'])).stdout).threads,
    '1',
  )
})

for (const link of ['.lake/packages', '.lake']) {
  test(`dependency lookup, inheritance and persisted mounts reject a ${link} symlink into another project`, async (t) => {
    const { runtime, root, dataDir } = await fixture(t)
    const source = path.join(dataDir, 'selected-source')
    const sibling = path.join(dataDir, 'unrelated-project')
    await fs.mkdir(path.dirname(path.join(source, link)), { recursive: true })
    await fs.mkdir(path.join(sibling, 'packages'), { recursive: true })
    await fs.writeFile(path.join(sibling, 'private.txt'), 'PRIVATE_FIXTURE')
    await fs.writeFile(
      path.join(sibling, 'packages/private.txt'),
      'PRIVATE_FIXTURE',
    )
    await fs.symlink(sibling, path.join(source, link))
    assert.throws(
      () => runtime.dependencyRoot(source),
      /real directories inside the selected dependency project/,
    )
    await assert.rejects(
      runtime.inheritDependencies(source, root),
      /real directories inside the selected dependency project/,
    )
    await fs.writeFile(
      path.join(dataDir, 'runtime/dependencies.json'),
      JSON.stringify({ [root]: source }),
    )
    await assert.rejects(
      runtime.run(root, ['true']),
      /real directories inside the selected dependency project/,
    )
    assert.equal(
      await fs.readFile(path.join(sibling, 'private.txt'), 'utf8'),
      'PRIVATE_FIXTURE',
    )
  })
}

test('dependency lookup rejects dangling directory symlinks rather than treating them as an empty cache', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  await fs.mkdir(path.join(root, '.lake'))
  await fs.symlink(
    path.join(dataDir, 'missing'),
    path.join(root, '.lake/packages'),
  )
  assert.throws(
    () => runtime.dependencyRoot(root),
    /real directories inside the selected dependency project/,
  )
})

test('writable Lake cache is opt-in and requires a read-only workspace', async (t) => {
  const { runtime, root } = await fixture(t)
  await assert.rejects(
    runtime.run(root, ['true'], { writeLakeCache: true }),
    /requires a read-only workspace/,
  )
  await assert.rejects(
    runtime.run(root, ['true'], { ...cacheOptions, writeLakeCache: 'true' }),
    /must be booleans/,
  )
  const defaultRun = await runtime.run(root, ['true'])
  assert.equal(defaultRun.code, 0, defaultRun.stderr)
  const defaultMounts = mounts(JSON.parse(defaultRun.stdout))
  assert(defaultMounts.includes(`type=bind,src=${root},dst=/workspace`))
  assert(
    defaultMounts.includes(`type=bind,src=${root}/.lake,dst=/workspace/.lake`),
  )
  assert(
    defaultMounts.includes(
      `type=bind,src=${root}/.lake/packages,dst=/workspace/.lake/packages`,
    ),
  )
  const readonly = await runtime.run(root, ['true'], {
    readOnlyWorkspace: true,
  })
  const readonlyMounts = mounts(JSON.parse(readonly.stdout))
  assert(
    readonlyMounts.includes(`type=bind,src=${root},dst=/workspace,readonly`),
  )
  assert(
    readonlyMounts.includes(
      `type=bind,src=${root}/.lake,dst=/workspace/.lake,readonly`,
    ),
  )
})

test('cache overlay is private and nested dependency overlay remains read-only', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const source = path.join(dataDir, 'dependency-source')
  await fs.mkdir(path.join(source, '.lake/packages'), { recursive: true })
  await fs.writeFile(
    path.join(source, '.lake/packages', 'sentinel'),
    'dependency',
  )
  await fs.writeFile(
    path.join(dataDir, 'runtime/dependencies.json'),
    JSON.stringify({ [root]: source }),
  )
  const result = await runtime.run(root, ['true'], cacheOptions)
  assert.equal(result.code, 0, result.stderr)
  const actual = mounts(JSON.parse(result.stdout))
  const sourceIndex = actual.indexOf(
    `type=bind,src=${root},dst=/workspace,readonly`,
  )
  const cacheIndex = actual.indexOf(
    `type=bind,src=${root}/.lake,dst=/workspace/.lake`,
  )
  const dependencyIndex = actual.indexOf(
    `type=bind,src=${source}/.lake/packages,dst=/workspace/.lake/packages,readonly`,
  )
  assert(
    sourceIndex >= 0 &&
      cacheIndex > sourceIndex &&
      dependencyIndex > cacheIndex,
  )
  assert.equal((await fs.stat(path.join(root, '.lake'))).mode & 0o777, 0o700)
})

test('cache overlay rejects a symlink or file in place of .lake', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const lake = path.join(root, '.lake')
  await fs.symlink(dataDir, lake)
  await assert.rejects(
    runtime.run(root, ['true'], cacheOptions),
    /replaced by a symlink or file/,
  )
  await fs.unlink(lake)
  await fs.writeFile(lake, 'not a directory')
  await assert.rejects(
    runtime.run(root, ['true'], cacheOptions),
    /replaced by a symlink or file/,
  )
})

test('cache overlay rejects existing writable aliases of read-only source inodes', async (t) => {
  const { runtime, root } = await fixture(t)
  const source = path.join(root, 'Main.lean')
  const nested = path.join(root, '.lake/build')
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(source, 'example : True := by trivial\n')
  await fs.link(source, path.join(nested, 'alias'))
  await assert.rejects(
    runtime.run(root, ['true'], cacheOptions),
    /must not contain hardlinked files/,
  )
  assert.equal(
    await fs.readFile(source, 'utf8'),
    'example : True := by trivial\n',
  )
})

test('cache scan does not follow symlinks or inspect read-only dependency content', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const source = path.join(dataDir, 'dependency-source')
  await fs.mkdir(path.join(source, '.lake/packages'), { recursive: true })
  await fs.mkdir(path.join(root, '.lake/packages'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await fs.link(
    path.join(root, 'Main.lean'),
    path.join(root, '.lake/packages/hidden-alias'),
  )
  await fs.symlink('..', path.join(root, '.lake/cycle'))
  await fs.writeFile(
    path.join(dataDir, 'runtime/dependencies.json'),
    JSON.stringify({ [root]: source }),
  )
  const result = await runtime.run(root, ['true'], cacheOptions)
  assert.equal(result.code, 0, result.stderr)
})

test('setup RPC workers wait for runtime capacity and queued cancellation never spawns a worker', async (t) => {
  const { runtime, root } = await fixture(t)
  runtime.maxConcurrent = 1
  const occupied = runtime.spawn(root, ['true'], { cleanHome: true })
  const next = runtime.spawnWhenAvailable(root, ['true'], { cleanHome: true })
  assert.equal(runtime.queue.length, 1)
  const controller = new AbortController()
  const cancelled = runtime.spawnWhenAvailable(root, ['true'], {
    cleanHome: true,
    signal: controller.signal,
  })
  controller.abort(new Error('Cancelled queued RPC'))
  await assert.rejects(cancelled, /Cancelled queued RPC/)
  assert.equal(runtime.queue.length, 1)
  occupied.stdin.end()
  const child = await next
  child.stdin.end()
  await child.workerStopped
  assert.equal(runtime.queue.length, 0)
  assert.equal(runtime.children.size, 0)
})

test('temporary repair cleanup removes its home and self binding but preserves a source referenced by another workspace', async (t) => {
  const { runtime, dataDir } = await fixture(t)
  const root = path.join(dataDir, 'setup-repairs', 'repair', 'workspace')
  const target = path.join(dataDir, 'snapshot')
  await fs.mkdir(path.join(root, '.lake/packages/mathlib'), { recursive: true })
  await fs.mkdir(target)
  await runtime.claimTemporaryWorkspace(root)
  await runtime.inheritDependencies(root, root)
  const home = await runtime.home(root)
  await runtime.inheritDependencies(root, target)
  await runtime.releaseTemporaryWorkspace(root)
  assert((await fs.stat(root)).isDirectory())
  assert((await fs.stat(home)).isDirectory())
  await fs.rm(target, { recursive: true })
  await runtime.releaseTemporaryWorkspace(root)
  await assert.rejects(fs.stat(root), { code: 'ENOENT' })
  await assert.rejects(fs.stat(home), { code: 'ENOENT' })
  const registry = JSON.parse(
    await fs.readFile(path.join(dataDir, 'runtime/dependencies.json'), 'utf8'),
  )
  assert.equal(registry[root], undefined)
})

test('detaching a changed preset environment preserves the dependency mounts of existing snapshots', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const template = path.join(dataDir, 'template'),
    snapshot = path.join(dataDir, 'snapshot')
  await fs.mkdir(path.join(template, '.lake/packages/mathlib'), {
    recursive: true,
  })
  await fs.mkdir(snapshot)
  await runtime.inheritDependencies(template, root)
  await runtime.inheritDependencies(root, snapshot)
  assert.equal(runtime.dependencyRoot(root), template)
  await runtime.clearInheritedDependencies(root, { force: true })
  assert.equal(runtime.dependencyRoot(root), null)
  assert.equal(runtime.dependencyRoot(snapshot), template)
  const child = await runtime.run(snapshot, ['true'], { cleanHome: true })
  assert.equal(child.code, 0)
  assert(
    mounts(JSON.parse(child.stdout)).some((mount) =>
      mount.includes(
        `src=${template}/.lake/packages,dst=/workspace/.lake/packages,readonly`,
      ),
    ),
  )
})

test('worker home preparation rejects a settings FIFO race without blocking the server', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const home = await runtime.home(root)
  const { spawnSync } = await import('node:child_process')
  const script = `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
import {Runtime} from ${JSON.stringify(new URL('../runtime.mjs', import.meta.url).href)}
const [dataDir, root, home] = process.argv.slice(1)
const runtime = new Runtime({dataDir})
const target = home + '/.elan/settings.toml'
const original = fs.lstatSync
let swapped = false
fs.lstatSync = (...args) => {
  const stat = original(...args)
  if (!swapped && args[0] === target) {
    swapped = true
    fs.unlinkSync(target)
    assert.equal(spawnSync('mkfifo', [target]).status, 0)
  }
  return stat
}
try {
  await assert.rejects(runtime.home(root))
  assert.equal(swapped, true)
  console.log('FIFO race rejected')
} finally { fs.lstatSync = original }
`
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, dataDir, root, home],
    { encoding: 'utf8', timeout: 5000 },
  )
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /FIFO race rejected/)
})

test('worker toolchain link replacement stays within the pinned home parent', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const home = await runtime.home(root)
  const version = 'leanprover/lean4:v4.34.1'
  const name = 'leanprover--lean4---v4.34.1'
  const outside = path.join(dataDir, 'protected-toolchains')
  const old = path.join(home, 'original-toolchains')
  await fs.mkdir(path.join(outside, name), { recursive: true })
  await fs.writeFile(path.join(outside, name, 'private'), 'protected')
  await fs.symlink(
    '/opt/stale-toolchain',
    path.join(home, '.elan/toolchains', name),
  )
  runtime.toolchains.set(version, path.join(outside, name))
  const syncFs = (await import('node:fs')).default
  const readlink = syncFs.readlinkSync
  let swapped = false
  const mock = t.mock.method(syncFs, 'readlinkSync', (...args) => {
    if (!swapped && String(args[0]).endsWith('/' + name)) {
      swapped = true
      syncFs.renameSync(path.join(home, '.elan/toolchains'), old)
      syncFs.symlinkSync(outside, path.join(home, '.elan/toolchains'))
    }
    return readlink(...args)
  })
  try {
    await runtime.home(root)
  } finally {
    mock.mock.restore()
  }
  assert.equal(swapped, true)
  assert.equal(
    await fs.readFile(path.join(outside, name, 'private'), 'utf8'),
    'protected',
  )
  assert.equal(
    await fs.readlink(path.join(old, name)),
    '/opt/lean-toolchains/' + name,
  )
})

test('worker home cache reuse copies exact lookup bytes and keeps artifact archives read only', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const source = path.join(dataDir, 'source-cache-project')
  await fs.mkdir(path.join(source, '.lake/packages/mathlib'), {
    recursive: true,
  })
  const sourceHome = await runtime.home(source)
  const cache = path.join(sourceHome, '.cache/lake')
  await fs.mkdir(path.join(cache, 'artifacts'))
  await fs.mkdir(path.join(cache, 'outputs/nested'), { recursive: true })
  await fs.mkdir(path.join(cache, 'revisions'))
  const bytes = Buffer.from([0, 255, 128, 65])
  await fs.writeFile(path.join(cache, 'artifacts/fixture.ltar'), 'artifact')
  await fs.writeFile(path.join(cache, 'outputs/nested/map'), bytes)
  await fs.writeFile(path.join(cache, 'revisions/map'), bytes)
  await runtime.inheritDependencies(source, root)
  const home = await runtime.home(root)
  assert.deepEqual(
    await fs.readFile(path.join(home, '.cache/lake/outputs/nested/map')),
    bytes,
  )
  assert.deepEqual(
    await fs.readFile(path.join(home, '.cache/lake/revisions/map')),
    bytes,
  )
  assert.equal(
    await fs.readlink(path.join(home, '.cache/lake/artifacts/fixture.ltar')),
    '/opt/dependency-lake-cache/artifacts/fixture.ltar',
  )
})

test('all writable future mount sources and their home ancestors are separate mountpoints', async (t) => {
  const { runtime, root } = await fixture(t)
  const argv = JSON.parse((await runtime.run(root, ['true'])).stdout)
  const actual = mounts(argv)
  const home = actual
    .find((mount) => mount.endsWith('dst=/home/worker'))
    .split(',src=')[1]
    .split(',dst=')[0]
  for (const relative of ['.cache', '.cache/lake'])
    assert(
      actual.includes(
        `type=bind,src=${home}/${relative},dst=/home/worker/${relative}`,
      ),
    )
  for (const relative of ['.lake', '.lake/packages'])
    assert(
      actual.includes(
        `type=bind,src=${root}/${relative},dst=/workspace/${relative}`,
      ),
    )
})

test('the initial fixed Git clone can keep an empty destination without disabling later cache pinning', async (t) => {
  const { runtime, root } = await fixture(t)
  const clone = JSON.parse(
    (
      await runtime.run(
        root,
        ['git', 'clone', '--', 'https://example.com/fixture.git', '.'],
        { emptyRepositoryClone: true },
      )
    ).stdout,
  )
  assert(!mounts(clone).some((mount) => mount.includes('dst=/workspace/.lake')))
  assert.deepEqual(await fs.readdir(root), [])
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  const existing = JSON.parse(
    (
      await runtime.run(
        root,
        ['git', 'clone', '--', 'https://example.com/fixture.git', '.'],
        { emptyRepositoryClone: true },
      )
    ).stdout,
  )
  assert(
    mounts(existing).includes(
      `type=bind,src=${root}/.lake,dst=/workspace/.lake`,
    ),
  )
})

test('writable cache inspection rejects a nested directory replaced by a host symlink', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  await fs.mkdir(path.join(root, '.lake/build'), { recursive: true })
  const outside = path.join(dataDir, 'private-cache-fixture')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'private'), 'protected')
  const syncFs = (await import('node:fs')).default
  const readdir = syncFs.readdirSync
  let swapped = false
  const mock = t.mock.method(syncFs, 'readdirSync', (...args) => {
    const entries = readdir(...args)
    if (!swapped && syncFs.realpathSync(args[0]) === path.join(root, '.lake')) {
      swapped = true
      syncFs.renameSync(
        path.join(root, '.lake/build'),
        path.join(root, '.lake/original-build'),
      )
      syncFs.symlinkSync(outside, path.join(root, '.lake/build'))
    }
    return entries
  })
  try {
    await assert.rejects(runtime.run(root, ['true'], cacheOptions))
  } finally {
    mock.mock.restore()
  }
  assert.equal(swapped, true)
  assert.equal(
    await fs.readFile(path.join(outside, 'private'), 'utf8'),
    'protected',
  )
})
