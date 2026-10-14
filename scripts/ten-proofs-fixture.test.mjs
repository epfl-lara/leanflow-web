import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  dependencies,
  expectedFiles,
  modules,
  parseOptions,
  seedDependencySources,
  validateDependencySources,
} from './ten-proofs-fixture.mjs'

const execute = promisify(execFile)
async function git(directory, args) {
  const result = await execute(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith('GIT_'),
          ),
        ),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  )
  return result.stdout.trim()
}

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ten-proofs-fixture-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const sources = path.join(directory, 'sources')
  const checkout = path.join(sources, 'mathlib')
  await fs.mkdir(checkout, { recursive: true })
  await git(checkout, ['init'])
  await fs.writeFile(
    path.join(checkout, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await git(checkout, ['add', 'Main.lean'])
  await git(checkout, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Public fixture',
  ])
  const rev = await git(checkout, ['rev-parse', 'HEAD'])
  const packages = [
    {
      name: 'mathlib',
      rev,
      url: 'https://github.com/leanprover-community/mathlib4',
    },
  ]
  await git(checkout, ['remote', 'add', 'origin', packages[0].url])
  return { directory, sources, checkout, packages }
}

test('portable options use one worker resource defaults and bounded configurable deadlines', () => {
  const options = parseOptions([])
  assert.equal(options.image, 'lemex-web-worker:local')
  assert.equal(options.cpus, 6)
  assert.equal(options.memory, '24g')
  assert.equal(options.timeoutMs, 240 * 60_000)
  assert.equal(options.dependencySources, null)
  assert.deepEqual(parseOptions(['--help']), { help: true })
  assert.equal(
    parseOptions(['--cpus=2', '--memory', '16g', '--timeout-minutes', '120'])
      .cpus,
    2,
  )
  for (const args of [
    ['--unknown'],
    ['--memory'],
    ['--cpus', '0'],
    ['--cpus', 'Infinity'],
    ['--memory', '0g'],
    ['--image', 'contains spaces'],
    ['--timeout-minutes', '1441'],
    ['--cpus', '1', '--cpus', '2'],
  ])
    assert.throws(() => parseOptions(args))
})

test('public fixture records every tracked source and exact Lean dependency pins', () => {
  assert.equal(Object.keys(expectedFiles).length, 43)
  assert.equal(modules.length, 10)
  for (const module of modules) {
    assert.match(expectedFiles[`${module}.lean`].sha256, /^[a-f0-9]{64}$/)
    assert(expectedFiles[`${module}.lean`].bytes > 0)
  }
  assert.equal(
    dependencies.find((pkg) => pkg.name === 'mathlib').rev,
    '81a5d257c8e410db227a6665ed08f64fea08e997',
  )
  assert.equal(
    dependencies.find((pkg) => pkg.name === 'Comparator').rev,
    '07bc4ea40f2266dcb861820a2ec1fa3244ed307f',
  )
})

test('source-only assistance reconstructs exact Git checkout without source config or hooks', async (t) => {
  const { directory, sources, checkout, packages } = await fixture(t)
  await git(checkout, ['config', 'fixture.canary', 'SHOULD-NOT-COPY'])
  await fs.writeFile(
    path.join(checkout, '.git', 'hooks', 'post-checkout'),
    '#!/bin/sh\nexit 91\n',
    { mode: 0o700 },
  )
  assert.equal(await validateDependencySources(sources, packages), sources)
  const stage = path.join(directory, 'stage')
  await seedDependencySources(sources, stage, packages)
  const seeded = path.join(stage, '.lake', 'packages', 'mathlib')
  assert.equal(await git(seeded, ['rev-parse', 'HEAD']), packages[0].rev)
  assert.equal(
    await git(seeded, ['remote', 'get-url', 'origin']),
    packages[0].url,
  )
  assert.equal(
    await fs.readFile(path.join(seeded, 'Main.lean'), 'utf8'),
    'example : True := by trivial\n',
  )
  assert(
    !(await fs.readFile(path.join(seeded, '.git', 'config'), 'utf8')).includes(
      'SHOULD-NOT-COPY',
    ),
  )
  await assert.rejects(
    fs.stat(path.join(seeded, '.git', 'hooks', 'post-checkout')),
    { code: 'ENOENT' },
  )
})

test('inherited Git settings cannot redirect public fixture validation or reconstruction', async (t) => {
  const { directory, sources, packages } = await fixture(t)
  const { checkout: external } = await fixture(t)
  await fs.writeFile(
    path.join(external, 'Main.lean'),
    '-- An unrelated repository must remain untouched.\n',
  )
  await git(external, ['add', 'Main.lean'])
  await git(external, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Unrelated repository',
  ])
  const snapshot = async (root) => {
    const files = (await fs.readdir(root, { recursive: true })).sort()
    return Promise.all(
      files.map(async (filename) => {
        const absolute = path.join(root, filename)
        return [
          filename,
          (await fs.lstat(absolute)).isDirectory()
            ? 'directory'
            : createHash('sha256')
                .update(await fs.readFile(absolute))
                .digest('hex'),
        ]
      }),
    )
  }
  const before = await snapshot(external)
  const poisoned = {
    GIT_DIR: path.join(external, '.git'),
    GIT_WORK_TREE: external,
    GIT_COMMON_DIR: path.join(external, '.git'),
    GIT_INDEX_FILE: path.join(external, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: path.join(external, '.git', 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(external, '.git', 'objects'),
    GIT_CONFIG_PARAMETERS: "'fixture.inherited'='poisoned'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.url',
    GIT_CONFIG_VALUE_0: 'https://example.invalid/unrelated.git',
    GIT_TRACE: path.join(external, 'unexpected-git-trace'),
    GIT_TRACE2_EVENT: path.join(external, 'unexpected-git-events'),
    GIT_NAMESPACE: 'unrelated',
  }
  const previous = Object.fromEntries(
    Object.keys(poisoned).map((name) => [name, process.env[name]]),
  )
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  })
  Object.assign(process.env, poisoned)
  assert.equal(await validateDependencySources(sources, packages), sources)
  const stage = path.join(directory, 'stage')
  await seedDependencySources(sources, stage, packages)
  const seeded = path.join(stage, '.lake', 'packages', 'mathlib')
  assert.equal(await git(seeded, ['rev-parse', 'HEAD']), packages[0].rev)
  assert.equal(
    await git(seeded, ['remote', 'get-url', 'origin']),
    packages[0].url,
  )
  assert.equal(
    await fs.readFile(path.join(seeded, 'Main.lean'), 'utf8'),
    'example : True := by trivial\n',
  )
  assert.deepEqual(await snapshot(external), before)
  for (const [name, value] of Object.entries(poisoned))
    assert.equal(process.env[name], value, 'The host environment is preserved')
})

test('source-only assistance rejects artifacts, private material, changed pins and origins', async (t) => {
  const { sources, checkout, packages } = await fixture(t)
  for (const filename of [
    'Main.olean',
    'local.trace',
    '.env',
    '.git-credentials',
  ]) {
    await fs.writeFile(path.join(checkout, filename), 'fixture')
    await assert.rejects(
      validateDependencySources(sources, packages),
      /forbidden/,
    )
    await fs.rm(path.join(checkout, filename))
  }
  await fs.mkdir(path.join(checkout, '.lake'))
  await assert.rejects(
    validateDependencySources(sources, packages),
    /forbidden/,
  )
  await fs.rm(path.join(checkout, '.lake'), { recursive: true })
  await assert.rejects(
    validateDependencySources(sources, [
      { ...packages[0], rev: '0'.repeat(40) },
    ]),
    /revision/,
  )
  await git(checkout, [
    'remote',
    'set-url',
    'origin',
    'https://example.invalid/private.git',
  ])
  await assert.rejects(
    validateDependencySources(sources, packages),
    /public origin/,
  )
})

test('source assistance retains tracked public links and rejects escapes or Git metadata targets', async (t) => {
  const { directory, sources, checkout, packages } = await fixture(t)
  await fs.symlink('Main.lean', path.join(checkout, 'Alias.lean'))
  await fs.writeFile(
    path.join(checkout, 'public.trace'),
    'Public upstream support marker\n',
  )
  await git(checkout, ['add', 'Alias.lean', 'public.trace'])
  await git(checkout, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Public relative link',
  ])
  packages[0].rev = await git(checkout, ['rev-parse', 'HEAD'])
  await validateDependencySources(sources, packages)
  const stage = path.join(directory, 'stage')
  await seedDependencySources(sources, stage, packages)
  assert.equal(
    await fs.readlink(path.join(stage, '.lake/packages/mathlib/Alias.lean')),
    'Main.lean',
  )
  assert.equal(
    await fs.readFile(
      path.join(stage, '.lake/packages/mathlib/public.trace'),
      'utf8',
    ),
    'Public upstream support marker\n',
  )
  for (const target of [
    '../private-source',
    '.git/config',
    '/tmp/private-source',
  ]) {
    await fs.symlink(target, path.join(checkout, 'Escape.lean'))
    await assert.rejects(
      validateDependencySources(sources, packages),
      /outside its public sources/,
    )
    await fs.rm(path.join(checkout, 'Escape.lean'))
  }
})

test('source assistance rejects compiled artifacts even if tracked and excludes ignored local files', async (t) => {
  const { sources, checkout, packages } = await fixture(t)
  await fs.writeFile(path.join(checkout, '.gitignore'), 'local-output.txt\n')
  await git(checkout, ['add', '.gitignore'])
  await git(checkout, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Public ignore rule',
  ])
  packages[0].rev = await git(checkout, ['rev-parse', 'HEAD'])
  await fs.writeFile(
    path.join(checkout, 'local-output.txt'),
    'Never copy local state',
  )
  await assert.rejects(
    validateDependencySources(sources, packages),
    /ignored files/,
  )
  await fs.rm(path.join(checkout, 'local-output.txt'))
  await fs.writeFile(path.join(checkout, 'Main.olean'), 'Compiled fixture')
  await git(checkout, ['add', 'Main.olean'])
  await git(checkout, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Forbidden compiled fixture',
  ])
  packages[0].rev = await git(checkout, ['rev-parse', 'HEAD'])
  await assert.rejects(
    validateDependencySources(sources, packages),
    /forbidden/,
  )
})
