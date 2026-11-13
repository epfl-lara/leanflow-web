import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { BlobStore, validateManifest } from '../cluster/blobs.mjs'
import {
  captureDependencies,
  capturePreparedDependencies,
} from '../cluster/dependencies.mjs'
import { sharedDependencyCacheSchema } from '../shared-dependencies.mjs'

const execute = promisify(execFile)
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lf-dependency-')),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const environment = path.join(root, 'environment'),
    checkout = path.join(environment, '.lake/packages/example')
  await fs.mkdir(checkout, { recursive: true })
  const git = (args, cwd = checkout) =>
    execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      timeout: 10000,
    })
  const commit = async () => {
    await git(['add', '-A'])
    await git([
      '-c',
      'user.name=LeanFlow fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'Synthetic dependency fixture',
    ])
  }
  await git(['init', '--quiet'])
  await fs.writeFile(
    path.join(checkout, 'old.txt'),
    'EXCLUDED_HISTORY_SENTINEL',
  )
  await commit()
  await fs.rm(path.join(checkout, 'old.txt'))
  await fs.writeFile(
    path.join(checkout, 'Example.lean'),
    'theorem example_fixture : True := by trivial\n',
  )
  await commit()
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  await git([
    'config',
    'remote.origin.url',
    'https://user:EXCLUDED_CONFIG_SENTINEL@example.invalid/private',
  ])
  await fs.writeFile(
    path.join(checkout, '.git/hooks/pre-commit'),
    'EXCLUDED_HOOK_SENTINEL',
  )
  const manifest = {
    packages: [
      {
        name: 'example',
        type: 'git',
        rev: head,
        url: 'https://example.invalid/public.git',
      },
    ],
  }
  await fs.writeFile(
    path.join(environment, 'lake-manifest.json'),
    JSON.stringify(manifest),
  )
  const store = await new BlobStore(path.join(root, 'blobs')).init()
  return { root, environment, checkout, git, head, manifest, store }
}

test('offline dependency snapshots preserve the locked commit and a clean tree without original Git secrets or history', async (t) => {
  const f = await fixture(t)
  const captured = await captureDependencies(f.store, f.environment)
  const manifest = await f.store.manifest(captured.hash)
  for (const entry of manifest.entries.filter(
    (entry) => entry.type === 'file',
  )) {
    let bytes = await f.store.read(entry.hash)
    if (/\.git\/objects\//.test(entry.path)) bytes = inflateSync(bytes)
    assert.doesNotMatch(
      bytes.toString(),
      /EXCLUDED_(?:CONFIG|HOOK|HISTORY)_SENTINEL/,
    )
  }
  const output = path.join(f.root, 'exported')
  await f.store.materialize(captured.hash, output)
  const checkout = path.join(output, '.lake/packages/example')
  assert.equal(
    (await f.git(['rev-parse', 'HEAD'], checkout)).stdout.trim(),
    f.head,
  )
  assert.equal(
    (await f.git(['status', '--porcelain', '--untracked-files=no'], checkout))
      .stdout,
    '',
  )
  assert.equal(
    (await f.git(['log', '--format=%H'], checkout)).stdout.trim(),
    f.head,
  )
  assert.equal(
    (await f.git(['remote', 'get-url', 'origin'], checkout)).stdout.trim(),
    'https://example.invalid/public.git',
  )
})

test('dependency export rejects mismatched locks, credentialed URLs and Git directory pointers', async (t) => {
  const f = await fixture(t)
  f.manifest.packages[0].rev = '0'.repeat(40)
  await fs.writeFile(
    path.join(f.environment, 'lake-manifest.json'),
    JSON.stringify(f.manifest),
  )
  await assert.rejects(captureDependencies(f.store, f.environment))
  f.manifest.packages[0].rev = f.head
  f.manifest.packages[0].url = 'https://user:password@example.invalid/repo.git'
  await fs.writeFile(
    path.join(f.environment, 'lake-manifest.json'),
    JSON.stringify(f.manifest),
  )
  await assert.rejects(captureDependencies(f.store, f.environment))
  f.manifest.packages[0].url = 'https://example.invalid/public.git'
  await fs.writeFile(
    path.join(f.environment, 'lake-manifest.json'),
    JSON.stringify(f.manifest),
  )
  await fs.rename(path.join(f.checkout, '.git'), path.join(f.root, 'elsewhere'))
  await fs.writeFile(
    path.join(f.checkout, '.git'),
    'gitdir: ' + path.join(f.root, 'elsewhere'),
  )
  await assert.rejects(captureDependencies(f.store, f.environment))
})

test('maintenance capture accepts only a current protected cache with the requested toolchain', async (t) => {
  const f = await fixture(t)
  const key = 'a'.repeat(64)
  const root = path.join(f.root, 'runtime/shared-dependencies', key)
  await fs.mkdir(path.dirname(root), { recursive: true })
  await fs.rename(f.environment, root)
  const marker = path.join(root, '.ready.json')
  const version = 'leanprover/lean4:v4.35.0'
  await fs.writeFile(path.join(root, 'lean-toolchain'), version + '\n', {
    mode: 0o600,
  })
  const prepare = () =>
    capturePreparedDependencies(f.store, root, { dataDir: f.root, version })
  const writeMarker = (schema, markerKey = key) =>
    fs.writeFile(marker, JSON.stringify({ key: markerKey, schema }), {
      mode: 0o600,
    })
  await writeMarker(sharedDependencyCacheSchema - 1)
  await assert.rejects(prepare(), /current dependency cache/)
  await writeMarker(sharedDependencyCacheSchema, 'b'.repeat(64))
  await assert.rejects(prepare(), /current dependency cache/)
  await writeMarker(sharedDependencyCacheSchema)
  await assert.rejects(
    capturePreparedDependencies(f.store, root, {
      dataDir: f.root,
      version: 'leanprover/lean4:v4.34.1',
    }),
    /pinned toolchain/,
  )
  await assert.rejects(
    capturePreparedDependencies(f.store, root, {
      dataDir: path.join(f.root, 'other'),
      version,
    }),
    /server-managed/,
  )
  const alias = path.join(path.dirname(root), 'c'.repeat(64))
  await fs.symlink(root, alias)
  await assert.rejects(
    capturePreparedDependencies(f.store, alias, { dataDir: f.root, version }),
    /server-managed/,
  )
  const captured = await prepare()
  const manifest = await f.store.manifest(captured.hash)
  assert.equal(manifest.kind, 'dependencies')
  assert(manifest.entries.some((entry) => entry.path.endsWith('/Example.lean')))
})

test('only the generated dependency metadata shape can contain Git paths', () => {
  const base = { version: 1, kind: 'dependencies', entries: [] }
  for (const path of [
    'example/.git/hooks/pre-commit',
    'example/.git/config.worktree',
    'example/.git/objects/info/alternates',
    'example/.git/refs/remotes/origin/main',
  ])
    assert.throws(() =>
      validateManifest({ ...base, entries: [{ path, type: 'directory' }] }),
    )
  assert.throws(() =>
    validateManifest({
      ...base,
      kind: 'source',
      entries: [{ path: 'example/.git', type: 'directory' }],
    }),
  )
})
