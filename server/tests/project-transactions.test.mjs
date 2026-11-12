import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../workspaces.mjs'
import { TexBuildManager } from '../tex-builds.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const runtime = {
  templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
  templateRoot: () => null,
  prepareToolchain: async () => {},
  async run(root, args) {
    if (args[0] === 'lake' && args.includes('update')) {
      await fs.mkdir(path.join(root, '.lake'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[]}',
      )
    }
    return { code: 0, stdout: 'Lean version 4.34.1\n', stderr: '' }
  },
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-transactions-'),
  )
  let store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(project.id)
  await store.writeFile(project.id, 'alice', 'A.lean', '-- original A\n', null)
  await store.writeFile(project.id, 'alice', 'Z.lean', '-- original Z\n', null)
  await fs.chmod(path.join(project.root, 'A.lean'), 0o640)
  return {
    dataDir,
    project,
    get store() {
      return store
    },
    async reopen() {
      store.close()
      store = await new WorkspaceStore({ dataDir, runtime }).init()
      return store
    },
  }
}

const childSource = `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { WorkspaceStore } from ${JSON.stringify(new URL('../workspaces.mjs', import.meta.url).href)}
const [dataDir, projectId, stopAt, configuration] = process.argv.slice(1)
process.umask(0o077)
const store = await new WorkspaceStore({ dataDir, runtime: {} }).init()
const a = await store.readFile(projectId, 'alice', 'A.lean')
const z = await store.readFile(projectId, 'alice', 'Z.lean')
const changes = [
  { path: 'A.lean', beforeHash: a.hash, after: '-- new A\\n' },
  { path: 'nested/New.lean', beforeHash: null, after: '-- new file\\n' },
  { path: 'Z.lean', beforeHash: z.hash, after: null },
]
if (configuration === 'yes') {
  const original = await store.readFile(projectId, 'alice', 'lakefile.toml')
  changes.push({ path: 'lakefile.toml', beforeHash: original.hash, after: original.content + '\\n-- updated\\n' })
}
const originalRename = fs.rename
let reached = 0
fs.rename = async (source, destination) => {
  await originalRename(source, destination)
  if (String(source).includes('/staged/') || String(destination).includes('/before/') || String(destination).endsWith('/applied.json')) {
    if (reached++ === Number(stopAt)) process.kill(process.pid, 'SIGKILL')
  }
}
syncBuiltinESMExports()
await store.applyChanges(projectId, 'alice', changes)
throw new Error('Crash point was not reached.')
`

async function crash(f, stopAt, configuration = false) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      childSource,
      f.dataDir,
      f.project.id,
      String(stopAt),
      configuration ? 'yes' : 'no',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
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
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    1,
  )
}

async function state(f) {
  const read = async (name) =>
    fs.readFile(path.join(f.project.root, name), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  return [
    await read('A.lean'),
    await read('nested/New.lean'),
    await read('Z.lean'),
  ]
}

for (const [point, label] of [
  'edited-before',
  'edited-staged',
  'new-staged',
  'deleted-before',
  'commit-marker',
].entries())
  test(`SIGKILL after ${label} recovers atomically and reopening again is idempotent`, async (t) => {
    const f = await fixture(t)
    await crash(f, point)
    for (let reopen = 0; reopen < 2; reopen++) {
      await f.reopen()
      assert.deepEqual(
        await state(f),
        point === 4
          ? ['-- new A\n', '-- new file\n', null]
          : ['-- original A\n', null, '-- original Z\n'],
      )
      assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
      assert.equal(
        f.store.db
          .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
          .get().count,
        0,
      )
      assert.equal(
        (await fs.stat(path.join(f.project.root, 'A.lean'))).mode & 0o777,
        0o640,
      )
      await f.store.writeFile(
        f.project.id,
        'alice',
        `After${reopen}.lean`,
        '-- editing works\n',
        null,
      )
    }
    const histories = await fs.readdir(
      path.join(f.dataDir, 'history', f.project.id),
    )
    const backups = path.join(
      f.dataDir,
      'history',
      f.project.id,
      histories[0],
      'before',
    )
    if (point === 4)
      assert.equal(
        await fs.readFile(path.join(backups, '0'), 'utf8'),
        '-- original A\n',
      )
  })

test('committed recovery invalidates changed setup before releasing its intent', async (t) => {
  const f = await fixture(t)
  await crash(f, 6, true)
  await f.reopen()
  const project = f.store.get(f.project.id, 'alice')
  assert.equal(project.status, 'error')
  assert.equal(project.needsPreparation, true)
  assert.match(
    (await f.store.readFile(project.id, 'alice', 'lakefile.toml')).content,
    /updated/,
  )
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    0,
  )
})

test('failed rollback keeps the intent and retries original bytes on the next startup', async (t) => {
  const f = await fixture(t)
  await crash(f, 3)
  const originalRename = fs.rename
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (
      String(destination).endsWith('/Z.lean') &&
      ['rollback', 'before'].includes(
        path.basename(await fs.realpath(path.dirname(String(source)))),
      )
    )
      throw new Error('Fixture disk temporarily unavailable')
    return originalRename(source, destination)
  })
  syncBuiltinESMExports()
  try {
    await f.reopen()
    assert.match(
      f.store.get(f.project.id, 'alice').error,
      /administrator recovery/,
    )
    assert.deepEqual(await state(f), ['-- original A\n', null, null])
    await assert.rejects(
      f.store.writeFile(
        f.project.id,
        'alice',
        'Other.lean',
        '-- blocked\n',
        null,
      ),
      { status: 503 },
    )
    assert.equal(
      f.store.db
        .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
        .get().count,
      1,
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  await f.reopen()
  assert.deepEqual(await state(f), ['-- original A\n', null, '-- original Z\n'])
  assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
  await f.reopen()
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    0,
  )
})

for (const obstruction of [
  'unexpected-content',
  'symlink',
  'corrupt-intent',
  'corrupt-marker',
])
  test(`recovery refuses ${obstruction} without partial rollback or blocking another project`, async (t) => {
    const f = await fixture(t)
    const healthy = await f.store.create('alice', { preset: 'lean' })
    await f.store.jobs.get(healthy.id)
    await crash(f, 3)
    const pending = f.store.db
      .prepare('SELECT * FROM pending_project_transactions')
      .get()
    if (obstruction === 'unexpected-content')
      await fs.writeFile(
        path.join(f.project.root, 'Z.lean'),
        '-- external edit\n',
      )
    if (obstruction === 'symlink')
      await fs.symlink(
        path.join(healthy.root, 'Main.lean'),
        path.join(f.project.root, 'Z.lean'),
      )
    if (obstruction === 'corrupt-intent') {
      const intent = JSON.parse(pending.payload)
      intent.changes[0].before = Buffer.from(
        '-- substituted original\n',
      ).toString('base64')
      f.store.db
        .prepare('UPDATE pending_project_transactions SET payload=? WHERE id=?')
        .run(JSON.stringify(intent), pending.id)
    }
    if (obstruction === 'corrupt-marker')
      await fs.writeFile(
        path.join(
          f.dataDir,
          'history',
          f.project.id,
          pending.id,
          'applied.json',
        ),
        '{"version":1}',
      )
    await f.reopen()
    assert.equal(
      (await f.store.readFile(f.project.id, 'alice', 'A.lean')).content,
      '-- new A\n',
    )
    assert.equal(f.store.get(f.project.id, 'alice').needsPreparation, false)
    assert.match(
      f.store.get(f.project.id, 'alice').error,
      /administrator recovery/,
    )
    assert.match(
      f.store.list('alice').find((project) => project.id === f.project.id)
        .error,
      /administrator recovery/,
    )
    assert.doesNotThrow(() => f.store.sharing(f.project.id, 'alice'))
    await assert.rejects(
      f.store.writeFile(
        f.project.id,
        'alice',
        'Other.lean',
        '-- blocked\n',
        null,
      ),
      { status: 503 },
    )
    await assert.rejects(f.store.prepare(f.project.id, 'alice'), {
      status: 503,
    })
    await assert.rejects(f.store.retryFileRecovery(f.project.id, 'alice'), {
      status: 503,
    })
    await f.store.writeFile(
      healthy.id,
      'alice',
      'Healthy.lean',
      '-- still works\n',
      null,
    )
    assert.equal(
      f.store.db
        .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
        .get().count,
      1,
    )
    await f.reopen()
    assert.equal(
      (await f.store.readFile(f.project.id, 'alice', 'A.lean')).content,
      '-- new A\n',
    )
    assert.equal(
      (await f.store.readFile(healthy.id, 'alice', 'Healthy.lean')).content,
      '-- still works\n',
    )
  })

test('an ordinary apply failure rolls every file back and permits a later save', async (t) => {
  const f = await fixture(t)
  const originalRename = fs.rename
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (String(source).includes('/staged/1'))
      throw new Error('Fixture write failed')
    return originalRename(source, destination)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      f.store.applyChanges(f.project.id, 'alice', [
        {
          path: 'A.lean',
          beforeHash: hash('-- original A\n'),
          after: '-- changed\n',
        },
        { path: 'nested/New.lean', beforeHash: null, after: '-- new\n' },
        { path: 'Z.lean', beforeHash: hash('-- original Z\n'), after: null },
      ]),
      /save was not applied; your files are unchanged/,
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await state(f), ['-- original A\n', null, '-- original Z\n'])
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    0,
  )
  await f.store.writeFile(
    f.project.id,
    'alice',
    'A.lean',
    '-- next save\n',
    hash('-- original A\n'),
  )
})

test('an external edit before source mutation returns a conflict without retaining a recovery guard', async (t) => {
  const f = await fixture(t)
  const originalOpen = fs.open
  let changed = false
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (!changed && String(filename).includes('/staged/0')) {
      changed = true
      await fs.writeFile(
        path.join(f.project.root, 'A.lean'),
        '-- external edit\n',
      )
    }
    return originalOpen(filename, ...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      f.store.applyChanges(f.project.id, 'alice', [
        {
          path: 'A.lean',
          beforeHash: hash('-- original A\n'),
          after: '-- changed\n',
        },
        { path: 'Z.lean', beforeHash: hash('-- original Z\n'), after: null },
      ]),
      { status: 409 },
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await state(f), [
    '-- external edit\n',
    null,
    '-- original Z\n',
  ])
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    0,
  )
  await f.store.writeFile(
    f.project.id,
    'alice',
    'A.lean',
    '-- next save\n',
    hash('-- external edit\n'),
  )
})

for (const failure of ['configuration-save', 'intent-delete'])
  test(`a repaired ${failure} failure after commit returns success and publishes its notification`, async (t) => {
    const f = await fixture(t)
    const setup = await f.store.readFile(f.project.id, 'alice', 'lakefile.toml')
    const originalRename = fs.rename
    const originalPrepare = f.store.db.prepare.bind(f.store.db)
    let committed = false,
      failed = false
    t.mock.method(fs, 'rename', async (source, destination) => {
      const result = await originalRename(source, destination)
      if (String(destination).endsWith('/applied.json')) committed = true
      return result
    })
    syncBuiltinESMExports()
    t.mock.method(f.store.db, 'prepare', (sql) => {
      const selected =
        failure === 'configuration-save'
          ? sql.startsWith('INSERT INTO projects(')
          : sql.startsWith('DELETE FROM pending_project_transactions ')
      if (committed && selected && !failed) {
        failed = true
        throw new Error('Fixture database briefly unavailable')
      }
      return originalPrepare(sql)
    })
    const notifications = []
    const unsubscribe = f.store.subscribeChanges((event) =>
      notifications.push(event),
    )
    try {
      const result = await f.store.applyChanges(f.project.id, 'alice', [
        {
          path: 'A.lean',
          beforeHash: hash('-- original A\n'),
          after: '-- saved\n',
        },
        {
          path: 'lakefile.toml',
          beforeHash: setup.hash,
          after: setup.content + '\n-- saved\n',
        },
      ])
      assert.equal(failed, true)
      assert.equal(result.applied, 2)
      assert.equal(result.requiresPreparation, true)
      assert.equal(
        (await f.store.readFile(f.project.id, 'alice', 'A.lean')).content,
        '-- saved\n',
      )
      assert.equal(f.store.get(f.project.id, 'alice').needsPreparation, true)
      assert.equal(notifications.length, 1)
      assert.deepEqual(notifications[0].paths, ['A.lean', 'lakefile.toml'])
      assert.equal(
        f.store.db
          .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
          .get().count,
        0,
      )
    } finally {
      unsubscribe()
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })

test('renaming a blocked project preserves its readiness after administrator recovery', async (t) => {
  const f = await fixture(t)
  await crash(f, 3)
  await fs.writeFile(path.join(f.project.root, 'Z.lean'), '-- external edit\n')
  await f.reopen()
  await f.store.rename(f.project.id, 'alice', { name: 'Recovered project' })
  await fs.unlink(path.join(f.project.root, 'Z.lean'))
  await f.reopen()
  const project = f.store.get(f.project.id, 'alice')
  assert.equal(project.name, 'Recovered project')
  assert.equal(project.status, 'ready')
  assert.equal(project.error, undefined)
  assert.deepEqual(await state(f), ['-- original A\n', null, '-- original Z\n'])
})

const recoveryChild = `
import fs from 'node:fs/promises'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { WorkspaceStore } from ${JSON.stringify(new URL('../workspaces.mjs', import.meta.url).href)}
process.umask(0o077)
const [dataDir, kill] = process.argv.slice(1)
const originalOpen = fs.open
fs.open = async (filename, ...args) => {
  const handle = await originalOpen(filename, ...args)
  if (kill === 'yes' && String(filename).startsWith('/proc/self/fd/') && (await fs.realpath(path.dirname(String(filename)))).endsWith('/rollback')) {
    const originalWrite = handle.writeFile.bind(handle)
    handle.writeFile = async (content) => {
      await originalWrite(content.subarray(0, 5))
      process.kill(process.pid, 'SIGKILL')
    }
  }
  return handle
}
syncBuiltinESMExports()
const store = await new WorkspaceStore({ dataDir, runtime: {} }).init()
store.close()
`

test('SIGKILL while writing rollback staging recovers again without leaking project files and preserves restrictive modes', async (t) => {
  const f = await fixture(t)
  await crash(f, 3)
  const pending = f.store.db
    .prepare('SELECT id FROM pending_project_transactions')
    .get()
  // Exercise the durable SQL fallback after the original backup is unavailable.
  await fs.unlink(
    path.join(f.dataDir, 'history', f.project.id, pending.id, 'before', '0'),
  )
  for (const kill of ['yes', 'no']) {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', recoveryChild, f.dataDir, kill],
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
    if (kill === 'yes') {
      assert.equal(result.signal, 'SIGKILL', stderr)
      assert.equal(
        f.store.db
          .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
          .get().count,
        1,
      )
      assert(
        !(await fs.readdir(f.project.root)).some((name) =>
          name.startsWith('.lemex-'),
        ),
      )
    } else assert.equal(result.code, 0, stderr)
  }
  await f.reopen()
  assert.deepEqual(await state(f), ['-- original A\n', null, '-- original Z\n'])
  assert.equal(
    (await fs.stat(path.join(f.project.root, 'A.lean'))).mode & 0o777,
    0o640,
  )
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    0,
  )
})

for (const failure of ['write', 'sync'])
  test(`a staging ${failure} failure removes its private files before any intent or source mutation`, async (t) => {
    const f = await fixture(t)
    const originalOpen = fs.open
    t.mock.method(fs, 'open', async (filename, ...args) => {
      const handle = await originalOpen(filename, ...args)
      if (String(filename).includes('/staged/0')) {
        if (failure === 'write') {
          await handle.writeFile('partial')
          await handle.close()
          throw Object.assign(new Error('Fixture disk full'), {
            code: 'ENOSPC',
          })
        }
        handle.sync = async () => {
          throw new Error('Fixture storage sync failed')
        }
      }
      return handle
    })
    syncBuiltinESMExports()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(
          f.store.applyChanges(f.project.id, 'alice', [
            {
              path: 'A.lean',
              beforeHash: hash('-- original A\n'),
              after: '-- updated\n',
            },
          ]),
          /save was not applied; your files are unchanged/,
        )
        assert.deepEqual(
          await fs.readdir(path.join(f.dataDir, 'history', f.project.id)),
          [],
        )
      }
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
    assert.deepEqual(await state(f), [
      '-- original A\n',
      null,
      '-- original Z\n',
    ])
    assert.equal(
      f.store.db
        .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
        .get().count,
      0,
    )
  })

test('a recovery pause blocks viewer TeX admission and capture while ordinary error projects still permit viewer capture', async (t) => {
  const f = await fixture(t)
  await f.store.writeFile(
    f.project.id,
    'alice',
    'main.tex',
    '\\documentclass{article}\\begin{document}Proof\\end{document}',
    null,
  )
  await f.store.setMember(f.project.id, 'alice', 'bob', 'viewer')
  const ordinary = f.store.get(f.project.id, 'alice')
  ordinary.status = 'error'
  ordinary.error = 'Ordinary Lean build error'
  f.store.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(ordinary), ordinary.id)
  const container = path.join(f.dataDir, 'tex-builds', 'viewer-fixture')
  await fs.mkdir(container, { recursive: true })
  await f.store.captureTexSource(
    f.project.id,
    'bob',
    path.join(container, 'source'),
  )
  assert.match(
    await fs.readFile(path.join(container, 'source/main.tex'), 'utf8'),
    /Proof/,
  )
  ordinary.status = 'ready'
  delete ordinary.error
  f.store.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(ordinary), ordinary.id)
  await crash(f, 3)
  await fs.writeFile(path.join(f.project.root, 'Z.lean'), '-- external edit\n')
  await f.reopen()
  let admissions = 0
  const builds = new TexBuildManager({
    dataDir: f.dataDir,
    events: {},
    workspaces: f.store,
    runtime: {
      async texInfo() {
        admissions++
        return { available: true }
      },
      async runTex() {
        assert.fail('No worker may start')
      },
    },
  })
  await assert.rejects(
    builds.start('bob', f.project.id, { rootFile: 'main.tex' }),
    { status: 503 },
  )
  assert.equal(admissions, 0)
  await assert.rejects(
    f.store.captureTexSource(
      f.project.id,
      'bob',
      path.join(container, 'another-source'),
    ),
    { status: 503 },
  )
  assert.match(
    (await f.store.readFile(f.project.id, 'bob', 'main.tex')).content,
    /Proof/,
  )
})

test('ancestor file paths are rejected before parent creation and do not quarantine later saves', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.store.applyChanges(f.project.id, 'alice', [
      { path: 'Created', beforeHash: null, after: '-- file\n' },
      { path: 'Created/Child.lean', beforeHash: null, after: '-- child\n' },
    ]),
    { status: 400 },
  )
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    0,
  )
  await assert.rejects(fs.stat(path.join(f.project.root, 'Created')), {
    code: 'ENOENT',
  })
  await f.store.writeFile(
    f.project.id,
    'alice',
    'Healthy.lean',
    '-- saved\n',
    null,
  )
})

for (const defect of ['version', 'owner', 'path', 'hash-type', 'mode'])
  test(`a pending intent with invalid ${defect} is retained without restoring any file`, async (t) => {
    const f = await fixture(t)
    await crash(f, 3)
    const row = f.store.db
      .prepare('SELECT * FROM pending_project_transactions')
      .get()
    const intent = JSON.parse(row.payload)
    if (defect === 'version') intent.version = 2
    if (defect === 'owner') intent.owner = 'someone-else'
    if (defect === 'path') intent.changes[0].path = '../outside.lean'
    if (defect === 'hash-type')
      intent.changes[0].afterHash = [intent.changes[0].afterHash]
    if (defect === 'mode') intent.changes[0].mode = 0o4777
    f.store.db
      .prepare('UPDATE pending_project_transactions SET payload=? WHERE id=?')
      .run(JSON.stringify(intent), row.id)
    await f.reopen()
    assert.deepEqual(await state(f), ['-- new A\n', '-- new file\n', null])
    assert.match(
      f.store.get(f.project.id, 'alice').error,
      /administrator recovery/,
    )
    assert.equal(
      f.store.db
        .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
        .get().count,
      1,
    )
  })

test('original recovery bytes above 32 MiB reject the batch before any source mutation', async (t) => {
  const f = await fixture(t)
  const original = 'x'.repeat(7 * 1024 * 1024)
  const changes = []
  for (let index = 0; index < 5; index++) {
    const filename = `Large${index}.lean`
    await fs.writeFile(path.join(f.project.root, filename), original)
    changes.push({ path: filename, beforeHash: hash(original), after: null })
  }
  await assert.rejects(f.store.applyChanges(f.project.id, 'alice', changes), {
    status: 413,
  })
  for (const change of changes)
    assert.equal(
      (await fs.stat(path.join(f.project.root, change.path))).size,
      original.length,
    )
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    0,
  )
  await f.store.writeFile(
    f.project.id,
    'alice',
    'Healthy.lean',
    '-- still editable\n',
    null,
  )
})

test('legacy history without a pending intent is preserved without guessing a rollback', async (t) => {
  const f = await fixture(t)
  const legacy = path.join(
    f.dataDir,
    'history',
    f.project.id,
    'legacy-interrupted',
    'before',
  )
  await fs.mkdir(legacy, { recursive: true })
  await fs.writeFile(path.join(legacy, '0'), '-- legacy original\n')
  await fs.writeFile(path.join(f.project.root, 'A.lean'), '-- current file\n')
  await f.reopen()
  assert.equal(
    (await f.store.readFile(f.project.id, 'alice', 'A.lean')).content,
    '-- current file\n',
  )
  assert.equal(
    await fs.readFile(path.join(legacy, '0'), 'utf8'),
    '-- legacy original\n',
  )
})

test('large transactions apply, roll back and recover within a 64-descriptor process limit', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.project.root, 'Bulk'))
  for (let index = 0; index < 96; index++)
    await fs.writeFile(
      path.join(f.project.root, 'Bulk', `File${index}.lean`),
      `-- original ${index}\n`,
    )
  const source = `
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { WorkspaceStore } from ${JSON.stringify(new URL('../workspaces.mjs', import.meta.url).href)}
const [dataDir, projectId, operation] = process.argv.slice(1)
const store = await new WorkspaceStore({ dataDir, runtime: {} }).init()
if (operation !== 'recover') {
  const changes = []
  for (let index = 0; index < 96; index++) {
    const filename = 'Bulk/File' + index + '.lean'
    const before = await store.readFile(projectId, 'alice', filename)
    changes.push({ path: filename, beforeHash: before.hash, after: operation === 'apply' ? '-- committed\\n' : '-- interrupted\\n' })
  }
  const originalRename = fs.rename
  fs.rename = async (from, to) => {
    if (operation === 'rollback' && String(from).includes('/staged/') && String(to).endsWith('/File79.lean'))
      throw new Error('Fixture late write failure')
    const result = await originalRename(from, to)
    if (operation === 'kill' && String(to).endsWith('/before/79')) process.kill(process.pid, 'SIGKILL')
    return result
  }
  syncBuiltinESMExports()
  if (operation === 'rollback') await assert.rejects(store.applyChanges(projectId, 'alice', changes), /save was not applied; your files are unchanged/)
  else await store.applyChanges(projectId, 'alice', changes)
}
assert.equal(store.get(projectId, 'alice').status, 'ready')
assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM pending_project_transactions').get().count, 0)
for (let index = 0; index < 96; index++)
  assert.equal((await store.readFile(projectId, 'alice', 'Bulk/File' + index + '.lean')).content, '-- committed\\n')
store.close()
`
  for (const operation of ['apply', 'rollback', 'kill', 'recover']) {
    const child = spawn(
      'bash',
      [
        '-c',
        'ulimit -n 64\nexec "$@"',
        'bash',
        process.execPath,
        '--input-type=module',
        '-e',
        source,
        f.dataDir,
        f.project.id,
        operation,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 },
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    if (operation === 'kill') assert.equal(result.signal, 'SIGKILL', stderr)
    else assert.equal(result.code, 0, stderr)
  }
  await f.reopen()
  assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
})

for (const failure of ['commit-marker', 'new-file-rename'])
  test(`rollback after ${failure} ENOSPC needs no new history files or directories`, async (t) => {
    const f = await fixture(t)
    const originalOpen = fs.open,
      originalMkdir = fs.mkdir,
      originalRename = fs.rename
    const originalInode = (await fs.stat(path.join(f.project.root, 'A.lean')))
      .ino
    let full = false,
      recoveryCreates = 0
    t.mock.method(fs, 'open', async (filename, flags, ...args) => {
      if (
        failure === 'commit-marker' &&
        path.basename(String(filename)).startsWith('.applied-')
      )
        full = true
      if (full && typeof flags === 'number' && flags & 64) {
        recoveryCreates++
        throw Object.assign(
          new Error(`ENOSPC: fixture ${f.dataDir}/private-history`),
          { code: 'ENOSPC' },
        )
      }
      return originalOpen(filename, flags, ...args)
    })
    t.mock.method(fs, 'mkdir', async (filename, ...args) => {
      if (full && String(filename).startsWith(f.store.historyDir)) {
        recoveryCreates++
        throw Object.assign(new Error('Fixture storage full'), {
          code: 'ENOSPC',
        })
      }
      return originalMkdir(filename, ...args)
    })
    t.mock.method(fs, 'rename', async (source, destination) => {
      if (
        failure === 'new-file-rename' &&
        String(source).includes('/staged/0')
      ) {
        full = true
        throw Object.assign(new Error('Fixture storage full'), {
          code: 'ENOSPC',
        })
      }
      return originalRename(source, destination)
    })
    syncBuiltinESMExports()
    try {
      const changes =
        failure === 'commit-marker'
          ? [
              {
                path: 'A.lean',
                beforeHash: hash('-- original A\n'),
                after: '-- changed\n',
              },
              { path: 'Created.lean', beforeHash: null, after: '-- created\n' },
              {
                path: 'Z.lean',
                beforeHash: hash('-- original Z\n'),
                after: null,
              },
            ]
          : [{ path: 'Created.lean', beforeHash: null, after: '-- created\n' }]
      await assert.rejects(
        f.store.applyChanges(f.project.id, 'alice', changes),
        (error) => {
          assert.equal(error.status, 503)
          assert.match(
            error.message,
            /save was not applied; your files are unchanged/,
          )
          assert(!error.message.includes(f.dataDir))
          return true
        },
      )
      assert.equal(full, true)
      assert.equal(recoveryCreates, failure === 'commit-marker' ? 1 : 0)
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
    assert.deepEqual(await state(f), [
      '-- original A\n',
      null,
      '-- original Z\n',
    ])
    await assert.rejects(fs.stat(path.join(f.project.root, 'Created.lean')), {
      code: 'ENOENT',
    })
    assert.equal(
      (await fs.stat(path.join(f.project.root, 'A.lean'))).ino,
      originalInode,
    )
    assert.equal(
      f.store.get(f.project.id, 'alice').fileRecoveryRequired,
      undefined,
    )
    assert.equal(
      f.store.db
        .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
        .get().count,
      0,
    )
  })

test('an Admin retries transient failed rollback in-process and quarantine blocks archive without a saved event', async (t) => {
  const f = await fixture(t)
  const originalOpen = fs.open,
    originalRename = fs.rename
  const notifications = []
  const unsubscribe = f.store.subscribeChanges((event) =>
    notifications.push(event),
  )
  const beforeEvents = f.store.events(f.project.id, 'alice').length
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (path.basename(String(filename)).startsWith('.applied-'))
      throw Object.assign(new Error('Fixture marker unavailable'), {
        code: 'ENOSPC',
      })
    return originalOpen(filename, ...args)
  })
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (
      String(destination).endsWith('/A.lean') &&
      !String(source).includes('/staged/')
    )
      throw new Error('Fixture restore temporarily unavailable')
    return originalRename(source, destination)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      f.store.applyChanges(f.project.id, 'alice', [
        {
          path: 'A.lean',
          beforeHash: hash('-- original A\n'),
          after: '-- pending\n',
        },
      ]),
      { status: 503 },
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  assert.deepEqual(
    notifications.map((event) => event.kind),
    ['project'],
  )
  assert.equal(f.store.events(f.project.id, 'alice').length, beforeEvents)
  await assert.rejects(f.store.trash(f.project.id, 'alice'), { status: 503 })
  assert.equal(
    (await f.store.readFile(f.project.id, 'alice', 'A.lean')).content,
    '-- pending\n',
  )
  let idleChecks = 0
  const project = await f.store.retryFileRecovery(f.project.id, 'alice', {
    assertIdle: () => {
      idleChecks++
    },
  })
  assert.equal(idleChecks, 1)
  assert.equal(project.status, 'ready')
  assert.equal(project.fileRecoveryRequired, undefined)
  assert.deepEqual(
    notifications.map((event) => event.kind),
    ['project', 'project'],
  )
  assert.deepEqual(await state(f), ['-- original A\n', null, '-- original Z\n'])
  unsubscribe()
  await f.store.writeFile(
    f.project.id,
    'alice',
    'A.lean',
    '-- saved later\n',
    hash('-- original A\n'),
  )
})

test('retrying a committed configuration transaction persists preparation state while clearing its recovery view', async (t) => {
  const f = await fixture(t)
  const setup = await f.store.readFile(f.project.id, 'alice', 'lakefile.toml')
  const originalRename = fs.rename,
    originalPrepare = f.store.db.prepare.bind(f.store.db)
  let committed = false
  t.mock.method(fs, 'rename', async (source, destination) => {
    const result = await originalRename(source, destination)
    if (String(destination).endsWith('/applied.json')) committed = true
    return result
  })
  t.mock.method(f.store.db, 'prepare', (sql) => {
    if (committed && sql.startsWith('INSERT INTO projects('))
      throw new Error('Fixture configuration metadata unavailable')
    return originalPrepare(sql)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      f.store.applyChanges(f.project.id, 'alice', [
        {
          path: 'lakefile.toml',
          beforeHash: setup.hash,
          after: setup.content + '\n-- committed setup\n',
        },
      ]),
      { status: 503 },
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  const project = await f.store.retryFileRecovery(f.project.id, 'alice')
  assert.equal(project.fileRecoveryRequired, undefined)
  assert.equal(project.needsPreparation, true)
  assert.match(project.error, /configuration changed/i)
  const stored = JSON.parse(
    f.store.db.prepare('SELECT data FROM projects WHERE id=?').get(project.id)
      .data,
  )
  assert.equal(stored.fileRecoveryRequired, undefined)
  assert.equal(stored.needsPreparation, true)
  assert.match(
    (await f.store.readFile(project.id, 'alice', 'lakefile.toml')).content,
    /committed setup/,
  )
})

test('an unstarted conflict removes private staging after deleting its intent', async (t) => {
  const f = await fixture(t)
  const originalOpen = fs.open
  let changed = false
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (!changed && String(filename).includes('/staged/0')) {
      changed = true
      await fs.writeFile(path.join(f.project.root, 'A.lean'), '-- external\n')
    }
    return originalOpen(filename, ...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      f.store.applyChanges(f.project.id, 'alice', [
        {
          path: 'A.lean',
          beforeHash: hash('-- original A\n'),
          after: '-- proposed private content\n',
        },
      ]),
      { status: 409 },
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual(
    await fs.readdir(path.join(f.store.historyDir, f.project.id)),
    [],
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'alice', 'A.lean')).content,
    '-- external\n',
  )
})

test('new-file uploads sync data once per file and directories a bounded number of times', async (t) => {
  const f = await fixture(t)
  const originalOpen = fs.open
  let files = 0,
    directories = 0
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    const originalSync = handle.sync.bind(handle)
    handle.sync = async () => {
      if ((await handle.stat()).isDirectory()) directories++
      else files++
      return originalSync()
    }
    return handle
  })
  syncBuiltinESMExports()
  try {
    await f.store.upload(
      f.project.id,
      'alice',
      Array.from({ length: 40 }, (_, index) => ({
        path: `Bulk/${index}.lean`,
        content: '-- uploaded\n',
      })),
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(files, 42)
  assert(directories <= 12, `Directory syncs must stay bounded: ${directories}`)
})

for (const defect of ['hash', 'symlink', 'hardlink'])
  test(`recovery refuses an invalid ${defect} original backup instead of replacing saved content`, async (t) => {
    const f = await fixture(t)
    await crash(f, 1)
    const row = f.store.db
      .prepare('SELECT id FROM pending_project_transactions')
      .get()
    const backup = path.join(
      f.store.historyDir,
      f.project.id,
      row.id,
      'before',
      '0',
    )
    const outside = path.join(f.dataDir, 'original-fixture')
    await fs.writeFile(outside, '-- original A\n')
    if (defect === 'hash')
      await fs.writeFile(backup, '-- unverified original\n')
    else {
      await fs.unlink(backup)
      if (defect === 'symlink') await fs.symlink(outside, backup)
      else await fs.link(outside, backup)
    }
    await assert.rejects(f.store.retryFileRecovery(f.project.id, 'alice'), {
      status: 503,
    })
    assert.equal(
      (await f.store.readFile(f.project.id, 'alice', 'A.lean')).content,
      '-- new A\n',
    )
    assert.equal(await fs.readFile(outside, 'utf8'), '-- original A\n')
    assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
    assert.equal(
      f.store.db
        .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
        .get().count,
      1,
    )
  })
