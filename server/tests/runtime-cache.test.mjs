import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'

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
  const runtime = new Runtime({ dataDir, docker })
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
  assert(!defaultMounts.some((value) => value.includes('dst=/workspace/.lake')))
  const readonly = await runtime.run(root, ['true'], {
    readOnlyWorkspace: true,
  })
  const readonlyMounts = mounts(JSON.parse(readonly.stdout))
  assert(
    readonlyMounts.includes(`type=bind,src=${root},dst=/workspace,readonly`),
  )
  assert(
    !readonlyMounts.some((value) => value.includes('dst=/workspace/.lake')),
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
