import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createStudio } from '../studio.mjs'
import { assertMovePaths, parseMoveRequest } from '../workspace-moves.mjs'

const TOOLCHAIN = 'leanprover/lean4:v4.34.1'

class FakeRuntime {
  async init() {}
  info() {
    return { ready: true }
  }
  templates() {
    return [{ id: 'lean', toolchain: TOOLCHAIN, ready: true }]
  }
  templateRoot() {
    return null
  }
  async prepareToolchain() {}
  async run(root, args) {
    if (args[0] === 'git' && args.includes('init'))
      await fs.mkdir(path.join(root, '.git'), { recursive: true })
    if (args[0] === 'git' && args.includes('rev-parse'))
      return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'lake' && args[1] === 'update') {
      await fs.mkdir(path.join(root, '.lake'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[]}',
      )
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  spawn() {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () =>
      queueMicrotask(() => {
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0)
      })
    return child
  }
  async shutdown() {}
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-move-'))
  const config = {
    defaultModel: 'test',
    models: [{ id: 'test' }],
    provider: {},
    lemex: {},
    redact: String,
  }
  const runtime = new FakeRuntime()
  const studio = await createStudio({ dataDir, runtime, config })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await studio.workspaces.create('owner', {
    name: 'Move proofs',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  const token = (
    await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')
  ).trim()
  const tokens = { owner: token }
  for (const id of ['editor', 'viewer', 'stranger']) {
    tokens[id] = `${id}-test-token`
    studio.auth.users.push({
      id,
      name: id,
      tokenHash: createHash('sha256').update(tokens[id]).digest('hex'),
    })
  }
  await fs.writeFile(
    path.join(dataDir, 'auth', 'users.json'),
    JSON.stringify(studio.auth.users),
  )
  await studio.workspaces.setMember(project.id, 'owner', 'editor', 'editor')
  await studio.workspaces.setMember(project.id, 'owner', 'viewer', 'viewer')
  const url = `http://127.0.0.1:${studio.server.address().port}`
  const move = (body, as = 'owner') =>
    fetch(`${url}/api/projects/${project.id}/move`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  return {
    ...studio,
    store: studio.workspaces,
    project,
    move,
    dataDir,
    runtime,
  }
}

const write = (f, name, content = '-- ' + name + '\n') =>
  f.store.writeFile(f.project.id, 'owner', name, content, null)

test('request parsing and path rules reject malformed and self-containing moves', () => {
  assert.deepEqual(parseMoveRequest({ from: 'a', to: 'b' }), {
    from: 'a',
    to: 'b',
  })
  for (const body of [null, [], {}, { from: 'a' }, { from: 1, to: 'b' }])
    assert.throws(() => parseMoveRequest(body), { status: 400 })
  assert.throws(() => parseMoveRequest({ from: 'a', to: 'b', force: true }), {
    status: 400,
  })
  assert.throws(() => assertMovePaths('A', 'A'), { status: 400 })
  assert.throws(() => assertMovePaths('A', 'A/B'), { status: 400 })
  assert.doesNotThrow(() => assertMovePaths('A', 'AB/C'))
})

test('renaming and moving a file keeps its bytes, hash, mode and inode content', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.project.root, 'Proofs'))
  const content = 'theorem keep : True := trivial\n-- ünïcode\n'
  await write(f, 'Old.lean', content)
  const before = await f.store.readFile(f.project.id, 'owner', 'Old.lean')
  await fs.chmod(path.join(f.project.root, 'Old.lean'), 0o640)
  const stat = await fs.stat(path.join(f.project.root, 'Old.lean'))
  const renamed = await f.move({ from: 'Old.lean', to: 'New.lean' })
  assert.equal(renamed.status, 200)
  assert.deepEqual(await renamed.json(), {
    from: 'Old.lean',
    to: 'New.lean',
    kind: 'file',
  })
  const moved = await f.move({ from: 'New.lean', to: 'Proofs/New.lean' })
  assert.equal(moved.status, 200)
  const after = await f.store.readFile(f.project.id, 'owner', 'Proofs/New.lean')
  assert.equal(after.content, content)
  assert.equal(after.hash, before.hash)
  const result = await fs.stat(path.join(f.project.root, 'Proofs', 'New.lean'))
  assert.equal(result.ino, stat.ino, 'the same file is renamed, not copied')
  assert.equal(result.mode & 0o777, 0o640)
  for (const gone of ['Old.lean', 'New.lean'])
    await assert.rejects(f.store.readFile(f.project.id, 'owner', gone), {
      status: 404,
    })
})

test('renaming a folder moves every descendant, including binary data', async (t) => {
  const f = await fixture(t)
  const nested = path.join(f.project.root, 'Examples', 'deep')
  await fs.mkdir(nested, { recursive: true })
  const bytes = Buffer.from([0, 255, 1, 128])
  await fs.writeFile(path.join(nested, 'data.bin'), bytes)
  await fs.mkdir(path.join(f.project.root, 'Archive'))
  await write(f, 'Examples/A.lean', '-- A\n')
  const response = await f.move({ from: 'Examples', to: 'Archive/Examples' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).kind, 'folder')
  assert.deepEqual(
    await fs.readFile(
      path.join(f.project.root, 'Archive', 'Examples', 'deep', 'data.bin'),
    ),
    bytes,
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Archive/Examples/A.lean'))
      .content,
    '-- A\n',
  )
  await assert.rejects(fs.stat(path.join(f.project.root, 'Examples')), {
    code: 'ENOENT',
  })
})

test('moves never overwrite an existing file or folder', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean', '-- A\n')
  await write(f, 'B.lean', '-- B\n')
  await fs.mkdir(path.join(f.project.root, 'Dir'))
  await fs.mkdir(path.join(f.project.root, 'Empty'))
  await fs.mkdir(path.join(f.project.root, 'Other'))
  for (const body of [
    { from: 'A.lean', to: 'B.lean' },
    { from: 'A.lean', to: 'Dir' },
    { from: 'Other', to: 'Empty' },
    { from: 'Other', to: 'A.lean' },
  ])
    assert.equal((await f.move(body)).status, 409, JSON.stringify(body))
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'A.lean')).content,
    '-- A\n',
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'B.lean')).content,
    '-- B\n',
  )
  assert.equal(
    (await fs.stat(path.join(f.project.root, 'Empty'))).isDirectory(),
    true,
  )
})

test('invalid, same-path, self-descendant and missing-destination moves fail clearly', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  await fs.mkdir(path.join(f.project.root, 'Folder', 'Inner'), {
    recursive: true,
  })
  const cases = [
    [{ from: 'A.lean', to: 'A.lean' }, 400],
    [{ from: 'Folder', to: 'Folder/Inner/Folder' }, 400],
    [{ from: 'A.lean', to: 'Missing/A.lean' }, 404],
    [{ from: 'Nope.lean', to: 'B.lean' }, 404],
    [{ from: 'A.lean', to: '../escape.lean' }, 400],
    [{ from: '../A.lean', to: 'B.lean' }, 400],
    [{ from: 'A.lean', to: '/escape.lean' }, 400],
    [{ from: 'A.lean', to: 'x\\y.lean' }, 400],
    [{ from: 'A.lean', to: 'A.lean/inside' }, 400],
    [{ from: 'A.lean' }, 400],
    [{ from: 'A.lean', to: 'B.lean', force: true }, 400],
    [{ from: ['A.lean'], to: 'B.lean' }, 400],
  ]
  for (const [body, status] of cases) {
    const response = await f.move(body)
    assert.equal(response.status, status, JSON.stringify(body))
    assert.equal(typeof (await response.json()).error, 'string')
  }
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'A.lean')).content,
    '-- A.lean\n',
  )
  // Nothing was written outside the project, next to its root.
  await assert.rejects(
    fs.stat(path.join(path.dirname(f.project.root), 'escape.lean')),
    { code: 'ENOENT' },
  )
})

test('protected, hidden, dependency and setup paths are refused', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  await fs.mkdir(path.join(f.project.root, 'Tools'))
  await fs.writeFile(path.join(f.project.root, '.env'), 'SECRET=1\n')
  await fs.mkdir(path.join(f.project.root, '.git', 'hooks'), {
    recursive: true,
  })
  await fs.mkdir(path.join(f.project.root, '.lake', 'packages', 'dep'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(f.project.root, '.lake', 'packages', 'dep', 'D.lean'),
    '-- dep\n',
  )
  const refused = [
    ['lakefile.toml', 'Tools/lakefile.toml'],
    ['lean-toolchain', 'toolchain.txt'],
    ['A.lean', 'lakefile.lean'],
    ['A.lean', 'lean-toolchain'],
    ['.env', 'Tools/env.txt'],
    ['A.lean', '.env'],
    ['.git', 'Tools/git'],
    ['A.lean', '.git/hooks/pre-commit'],
    ['A.lean', 'node_modules/A.lean'],
    ['A.lean', '.lake/packages/dep/A.lean'],
    ['.lake/packages/dep/D.lean', 'D.lean'],
    ['A.lean', 'Tools/.ssh'],
  ]
  for (const [from, to] of refused) {
    const response = await f.move({ from, to })
    assert.ok([400, 403].includes(response.status), `${from} -> ${to}`)
  }
  assert.equal(
    (await fs.stat(path.join(f.project.root, '.env'))).isFile(),
    true,
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'A.lean')).content,
    '-- A.lean\n',
  )
})

test('folders containing protected data or symbolic links cannot be moved', async (t) => {
  const f = await fixture(t)
  // Link targets live in this test's private temporary directory.
  const outside = path.join(f.dataDir, 'outside-target')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'target.lean'), '-- outside\n')
  await fs.mkdir(path.join(f.project.root, 'Linked'))
  await fs.symlink(
    path.join(outside, 'target.lean'),
    path.join(f.project.root, 'Linked', 'link.lean'),
  )
  await fs.mkdir(path.join(f.project.root, 'Secrets'))
  await fs.writeFile(path.join(f.project.root, 'Secrets', '.env'), 'X=1\n')
  await fs.mkdir(path.join(f.project.root, 'Nested', '.lake'), {
    recursive: true,
  })
  await fs.symlink(outside, path.join(f.project.root, 'Escape'))
  for (const from of ['Linked', 'Secrets', 'Nested', 'Escape']) {
    const response = await f.move({ from, to: 'Moved' })
    assert.equal(response.status, 403, from)
  }
  await assert.rejects(fs.stat(path.join(f.project.root, 'Moved')), {
    code: 'ENOENT',
  })
  await write(f, 'A.lean')
  assert.equal(
    (await f.move({ from: 'A.lean', to: 'Escape/A.lean' })).status,
    403,
  )
  await assert.rejects(fs.stat(path.join(outside, 'A.lean')), {
    code: 'ENOENT',
  })
})

test('authorization: only editors and owners can move files', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  assert.equal(
    (await f.move({ from: 'A.lean', to: 'B.lean' }, null)).status,
    401,
  )
  assert.equal(
    (await f.move({ from: 'A.lean', to: 'B.lean' }, 'stranger')).status,
    404,
  )
  assert.equal(
    (await f.move({ from: 'A.lean', to: 'B.lean' }, 'viewer')).status,
    403,
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'A.lean')).content,
    '-- A.lean\n',
  )
  assert.equal(
    (await f.move({ from: 'A.lean', to: 'B.lean' }, 'editor')).status,
    200,
  )
})

test('a project being prepared refuses moves until preparation finishes', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  f.runtime.prepareToolchain = () => gate
  await f.store.prepare(f.project.id, 'owner')
  try {
    const response = await f.move({ from: 'A.lean', to: 'B.lean' })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /prepar/i)
  } finally {
    release()
    await f.store.jobs.get(f.project.id)
  }
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'A.lean')).content,
    '-- A.lean\n',
  )
})

test('a playground refuses moves with a conversion hint and keeps its file', async (t) => {
  const f = await fixture(t)
  // Preparing a real playground needs a prepared Mathlib template, so mark this
  // fixture project as a playground in its stored record instead.
  f.store.db
    .prepare(
      "UPDATE projects SET data=json_set(data,'$.kind','single-file') WHERE id=?",
    )
    .run(f.project.id)
  assert.equal(f.store.get(f.project.id, 'owner').kind, 'single-file')
  const response = await f.move({ from: 'Main.lean', to: 'Renamed.lean' })
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /Convert the playground/)
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Main.lean')).hash.length,
    64,
  )
})

test('active checks and Lemex runs block moves without being stopped', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  for (const kind of ['agent', 'check']) {
    const job = f.events.create('owner', { projectId: f.project.id, kind })
    const response = await f.move({ from: 'A.lean', to: 'B.lean' })
    assert.equal(response.status, 409, kind)
    assert.match((await response.json()).error, /renaming or moving files/)
    // The refusal does not cancel the run.
    assert.notEqual(f.events.getMetadata(job.id).status, 'cancelled')
    f.events.update(job.id, { status: 'cancelled' })
  }
  const other = f.events.create('editor', {
    projectId: f.project.id,
    kind: 'agent',
  })
  const collaborator = await f.move({ from: 'A.lean', to: 'B.lean' })
  assert.equal(collaborator.status, 409)
  f.events.update(other.id, { status: 'cancelled' })
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'A.lean')).content,
    '-- A.lean\n',
  )
  assert.equal((await f.move({ from: 'A.lean', to: 'B.lean' })).status, 200)
})

test('moves notify live editors for both paths and old-path saves cannot recreate the file', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.project.root, 'Dir'))
  await write(f, 'Dir/A.lean', '-- A\n')
  const stale = await f.store.readFile(f.project.id, 'owner', 'Dir/A.lean')
  const events = []
  f.store.subscribeChanges((event) => events.push(event))
  assert.equal((await f.move({ from: 'Dir', to: 'Renamed' })).status, 200)
  assert.deepEqual(events, [
    {
      projectId: f.project.id,
      paths: ['Dir', 'Renamed'],
      kind: 'files',
      removedPaths: ['Dir'],
      // Structured so live editors follow the rename instead of seeing a removal.
      moves: [{ from: 'Dir', to: 'Renamed' }],
    },
  ])
  // A stale editor holding the old path and hash conflicts instead of
  // recreating the old file.
  await assert.rejects(
    f.store.writeFile(
      f.project.id,
      'owner',
      'Dir/A.lean',
      '-- stale\n',
      stale.hash,
    ),
    { status: 409 },
  )
  await assert.rejects(fs.stat(path.join(f.project.root, 'Dir')), {
    code: 'ENOENT',
  })
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Renamed/A.lean')).content,
    '-- A\n',
  )
})

test('an audit-log failure after the rename still reports success and notifies live editors', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  const events = []
  f.store.subscribeChanges((event) => events.push(event))
  // Make the optional project event insert fail; the rename is already done.
  f.store.db.exec(
    "CREATE TRIGGER audit_unavailable BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  )
  const warn = console.warn
  console.warn = () => {}
  try {
    const response = await f.move({ from: 'A.lean', to: 'B.lean' })
    assert.equal(response.status, 200, await response.clone().text())
  } finally {
    console.warn = warn
    f.store.db.exec('DROP TRIGGER audit_unavailable')
  }
  assert.deepEqual(events.at(-1).moves, [{ from: 'A.lean', to: 'B.lean' }])
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'B.lean')).content,
    '-- A.lean\n',
  )
})

test('a completed move is recorded in the project event log', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  assert.equal((await f.move({ from: 'A.lean', to: 'B.lean' })).status, 200)
  assert.match(
    JSON.stringify(f.store.events(f.project.id, 'owner')),
    /Moved A\.lean to B\.lean/,
  )
})
