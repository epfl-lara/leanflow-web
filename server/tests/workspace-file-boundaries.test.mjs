import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import promiseFs, * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceStore } from '../workspaces.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'workspace-boundary-'),
  )
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args) {
      if (args[0] === 'lake' && args.includes('update'))
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          JSON.stringify({ packages: [] }),
        )
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', {
    preset: 'lean',
    name: 'Boundary',
  })
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  return { dataDir, store, project }
}

async function duringReadDirectory(t, directory, afterListing, action) {
  const original = promiseFs.readdir
  let swapped = false
  const mock = t.mock.method(promiseFs, 'readdir', async (...args) => {
    const entries = await original(...args)
    if (
      !swapped &&
      args[1]?.withFileTypes &&
      (await fs.realpath(args[0])) === directory
    ) {
      swapped = true
      await afterListing()
    }
    return entries
  })
  syncBuiltinESMExports()
  try {
    await action()
    assert.equal(swapped, true, 'The fixture must swap a path after listing it')
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
}

test('file listing rejects a replaced root without revealing host filenames', async (t) => {
  const { dataDir, store, project } = await fixture(t)
  const outside = path.join(dataDir, 'private-host-fixture')
  await fs.mkdir(outside)
  await fs.writeFile(
    path.join(outside, 'private-account-record.json'),
    'private',
  )
  await fs.rename(project.root, path.join(dataDir, 'original-project'))
  await fs.symlink(outside, project.root)
  await assert.rejects(store.files(project.id, 'alice'), { status: 409 })
})

for (const operation of ['files', 'changes'])
  test(`${operation} rejects a directory swapped for a host symlink after listing`, async (t) => {
    const { dataDir, store, project } = await fixture(t)
    const snapshot =
      operation === 'changes'
        ? await store.snapshot(project.id, 'alice', 'candidate-boundary')
        : null
    const root = snapshot?.root || project.root
    const selected = path.join(root, 'Proofs')
    const outside = path.join(dataDir, 'private-host-fixture')
    await fs.mkdir(selected)
    await fs.mkdir(outside)
    await fs.writeFile(
      path.join(outside, 'private-account-record.json'),
      'private',
    )
    await duringReadDirectory(
      t,
      root,
      async () => {
        await fs.rename(selected, path.join(dataDir, 'original-proofs'))
        await fs.symlink(outside, selected)
      },
      () =>
        assert.rejects(
          operation === 'changes'
            ? store.changes(snapshot)
            : store.files(project.id, 'alice'),
          { status: 409 },
        ),
    )
  })

test('file listing does not follow a file swapped for a host symlink', async (t) => {
  const { dataDir, store, project } = await fixture(t)
  const outside = path.join(dataDir, 'private-host-file')
  await fs.writeFile(outside, 'private content and metadata')
  await duringReadDirectory(
    t,
    project.root,
    async () => {
      await fs.unlink(path.join(project.root, 'Main.lean'))
      await fs.symlink(outside, path.join(project.root, 'Main.lean'))
    },
    () => assert.rejects(store.files(project.id, 'alice'), { status: 409 }),
  )
})

// Isolate the deliberate FIFO race: the vulnerable open blocks a libuv worker,
// so a child deadline must fail the regression rather than hang the full suite.
for (const operation of ['snapshot', 'changes'])
  test(`${operation} rejects a regular file replaced by a FIFO without blocking`, async (t) => {
    const { dataDir, store, project } = await fixture(t)
    const snapshot =
      operation === 'changes'
        ? await store.snapshot(project.id, 'alice', 'fifo-baseline')
        : null
    const selected = path.join(snapshot?.root || project.root, 'Main.lean')
    const script = `
import assert from 'node:assert/strict'
import fs, * as namedFs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { WorkspaceStore } from ${JSON.stringify(new URL('../workspaces.mjs', import.meta.url).href)}
const [dataDir, projectId, selected, operation, serialized] = process.argv.slice(1)
const store = await new WorkspaceStore({ dataDir, runtime: {} }).init()
const original = fs.open
let swapped = false
fs.open = async (filename, ...args) => {
  if (!swapped && String(filename).endsWith('/Main.lean')) {
    assert.equal(await namedFs.realpath(filename), selected)
    swapped = true
    await namedFs.unlink(selected)
    assert.equal(spawnSync('mkfifo', [selected]).status, 0)
  }
  return original(filename, ...args)
}
syncBuiltinESMExports()
try {
  await assert.rejects(
    operation === 'snapshot'
      ? store.snapshot(projectId, 'alice', 'fifo-copy')
      : store.changes(JSON.parse(serialized)),
    { status: 409 },
  )
  assert.equal(swapped, true)
  console.log('FIFO replacement rejected')
} finally {
  fs.open = original
  syncBuiltinESMExports()
  store.close()
}
`
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        dataDir,
        project.id,
        selected,
        operation,
        JSON.stringify(snapshot),
      ],
      { encoding: 'utf8', timeout: 5000 },
    )
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /FIFO replacement rejected/)
  })

for (const operation of [
  'batch save',
  'terminal publication',
  'agent publication',
])
  test(`${operation} cannot commit after account access is removed during staging`, async (t) => {
    const { store, project } = await fixture(t)
    const before = await store.readFile(project.id, 'alice', 'Main.lean')
    let active = true
    store.assertActorActive = () => {
      if (!active)
        throw Object.assign(new Error('Account removed'), { status: 404 })
    }
    let snapshot
    if (operation === 'terminal publication')
      snapshot = await store.terminalSnapshot(
        project.id,
        'alice',
        'staged-terminal',
      )
    if (operation === 'agent publication')
      snapshot = await store.snapshot(project.id, 'alice', 'staged-agent')
    if (snapshot)
      await fs.writeFile(
        path.join(snapshot.root, 'Main.lean'),
        '-- private pending edit\n',
      )
    const changes =
      operation === 'agent publication' ? await store.changes(snapshot) : null
    const originalOpen = promiseFs.open
    let staged = false
    const mockedOpen = t.mock.method(promiseFs, 'open', async (...args) => {
      const handle = await originalOpen(...args)
      if (
        String(args[0]).startsWith(store.historyDir + path.sep) &&
        String(args[0]).includes('/staged/')
      ) {
        const originalWrite = handle.writeFile.bind(handle)
        handle.writeFile = async (...contents) => {
          const result = await originalWrite(...contents)
          staged = true
          active = false
          return result
        }
      }
      return handle
    })
    syncBuiltinESMExports()
    try {
      const pending =
        operation === 'batch save'
          ? store.writeFiles(project.id, 'alice', [
              {
                path: 'Main.lean',
                content: '-- private pending edit\n',
                expectedHash: before.hash,
              },
            ])
          : operation === 'terminal publication'
            ? store.syncTerminal(snapshot)
            : store.syncLive(snapshot, changes)
      await assert.rejects(pending, { status: 404 })
      assert.equal(staged, true)
      assert.equal(
        await fs.readFile(path.join(project.root, 'Main.lean'), 'utf8'),
        before.content,
      )
    } finally {
      mockedOpen.mock.restore()
      syncBuiltinESMExports()
    }
  })
