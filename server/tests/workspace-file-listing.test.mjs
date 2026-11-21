import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../workspaces.mjs'
import { ProjectDocuments } from '../project-documents.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-file-list-'),
  )
  const runtime = {}
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  const project = {
    id: randomUUID(),
    owner: 'alice',
    name: 'File listing fixture',
    status: 'ready',
    root: '',
  }
  project.root = path.join(store.projectsDir, project.id)
  await fs.mkdir(project.root)
  await fs.writeFile(
    path.join(project.root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  store.db
    .prepare('INSERT INTO projects VALUES(?,?,?)')
    .run(project.id, project.owner, JSON.stringify(project))
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  t.after(async () => {
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return { store, runtime, project }
}

test('25 concurrent project file requests share one scan and return independent caller results', async (t) => {
  const f = await fixture(t)
  let release,
    scans = 0
  f.runtime.dependencyRoot = () => {
    scans++
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const alice = f.store.files(f.project.id, 'alice')
  const bob = f.store.files(f.project.id, 'bob')
  const peers = Array.from({ length: 23 }, () =>
    f.store.files(f.project.id, 'bob'),
  )
  await assert.rejects(f.store.files(f.project.id, 'outsider'), { status: 404 })
  assert.equal(scans, 1)
  release(f.project.root)
  const [first, second] = await Promise.all([alice, bob, ...peers])
  assert.deepEqual(first, second)
  assert.notEqual(first, second)
  first[0].path = 'Changed only in one response'
  assert.equal(second[0].path, 'Main.lean')
})

test('a save invalidates an in-flight listing without older completion removing the newer scan', async (t) => {
  const f = await fixture(t)
  const gates = []
  f.runtime.dependencyRoot = () => new Promise((resolve) => gates.push(resolve))
  const earlier = f.store.files(f.project.id, 'alice')
  const source = await f.store.readFile(f.project.id, 'alice', 'Main.lean')
  await f.store.writeFile(
    f.project.id,
    'alice',
    'Main.lean',
    source.content + '-- saved\n',
    source.hash,
  )
  const current = f.store.files(f.project.id, 'bob')
  assert.equal(gates.length, 2)
  gates[0](f.project.root)
  await earlier
  const peer = f.store.files(f.project.id, 'alice')
  assert.equal(gates.length, 2)
  gates[1](f.project.root)
  const [first, second] = await Promise.all([current, peer])
  assert.deepEqual(first, second)
  assert.equal(first[0].size, Buffer.byteLength(source.content + '-- saved\n'))
})

test('external change notifications invalidate an in-flight listing before fanout', async (t) => {
  const f = await fixture(t)
  const documents = new ProjectDocuments({ workspaces: f.store })
  t.after(() => documents.close())
  const gates = []
  f.runtime.dependencyRoot = () => new Promise((resolve) => gates.push(resolve))
  const earlier = f.store.files(f.project.id, 'alice')
  documents.changed({ projectId: f.project.id, kind: 'files', paths: [] })
  const next = f.store.files(f.project.id, 'bob')
  assert.equal(gates.length, 2)
  for (const release of gates) release(f.project.root)
  await Promise.all([earlier, next])
})

test('listing completion rechecks revoked access and applies a current viewer role', async (t) => {
  const f = await fixture(t)
  let release
  f.runtime.dependencyRoot = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const downgraded = f.store.files(f.project.id, 'bob')
  await f.store.setMember(f.project.id, 'alice', 'bob', 'viewer')
  release(f.project.root)
  assert((await downgraded).every((file) => file.readOnly))
  const revoked = f.store.files(f.project.id, 'bob')
  const rejected = assert.rejects(revoked, { status: 404 })
  await f.store.removeMember(f.project.id, 'alice', 'bob')
  release(f.project.root)
  await rejected
})

test('completed file listings retain no metadata cache and refresh dependency revisions', async (t) => {
  const f = await fixture(t)
  const dependencyRoot = path.join(path.dirname(f.project.root), 'dependencies')
  const module = path.join(dependencyRoot, '.lake/packages/library/Proof.lean')
  await fs.mkdir(path.dirname(module), { recursive: true })
  await fs.writeFile(module, 'example : True := by trivial\n')
  let scans = 0
  f.runtime.dependencyRoot = () => {
    scans++
    return dependencyRoot
  }
  const first = await f.store.files(f.project.id, 'alice')
  const before = first.find(
    (file) => file.path === '.lake/packages/library/Proof.lean',
  )
  assert.equal(before.readOnly, true)
  await fs.appendFile(module, '-- updated dependency fixture\n')
  const second = await f.store.files(f.project.id, 'alice')
  const after = second.find((file) => file.path === before.path)
  assert.equal(scans, 2)
  assert.notEqual(after.revision, before.revision)
  assert(after.size > before.size)
})

test('a project-only listing leaves a full dependency scan in flight and still enforces access', async (t) => {
  const f = await fixture(t)
  let release
  f.runtime.dependencyRoot = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const full = f.store.files(f.project.id, 'alice')
  try {
    const files = await f.store.files(f.project.id, 'bob', {
      projectOnly: true,
    })
    assert.deepEqual(
      files.map(({ path }) => path),
      ['Main.lean'],
    )
    assert(files[0].revision)
    await assert.rejects(
      f.store.files(f.project.id, 'outsider', { projectOnly: true }),
      { status: 404 },
    )
  } finally {
    release(f.project.root)
    await full
  }
})

test('dependency links to regular auxiliary files preserve Lean source revisions', async (t) => {
  const f = await fixture(t)
  const dependencyRoot = path.join(path.dirname(f.project.root), 'dependencies')
  const library = path.join(dependencyRoot, '.lake/packages/library')
  await fs.mkdir(path.join(library, 'docs'), { recursive: true })
  await fs.writeFile(path.join(library, 'README.md'), '# Docs\n')
  await fs.writeFile(path.join(library, 'Basic.lean'), 'def value := 1\n')
  await fs.writeFile(path.join(library, 'script'), 'auxiliary file\n')
  await fs.symlink('../README.md', path.join(library, 'docs', 'README.md'))
  await fs.symlink('script', path.join(library, 'script.py'))
  f.runtime.dependencyRoot = () => dependencyRoot
  const first = await f.store.files(f.project.id, 'alice')
  assert(first.every(({ revision }) => revision))
  assert(!first.some(({ path }) => path.endsWith('/docs/README.md')))
  await fs.writeFile(path.join(library, 'Basic.lean'), 'def value := 2\n')
  const after = await f.store.files(f.project.id, 'alice')
  const module = '.lake/packages/library/Basic.lean'
  assert.notEqual(
    after.find(({ path }) => path === module)?.revision,
    first.find(({ path }) => path === module)?.revision,
  )
})

test('a link that could hide a Lean input leaves the file revisions uncertain', async (t) => {
  const f = await fixture(t)
  const dependencyRoot = path.join(path.dirname(f.project.root), 'dependencies')
  const library = path.join(dependencyRoot, '.lake/packages/library')
  await fs.mkdir(path.join(library, 'src'), { recursive: true })
  await fs.writeFile(path.join(library, 'src/Basic.lean'), 'def value := 1\n')
  await fs.writeFile(path.join(library, 'README.md'), '# Docs\n')
  f.runtime.dependencyRoot = () => dependencyRoot
  for (const [target, name, root] of [
    ['src', 'Alias.md', library],
    ['README.md', 'Alias.lean', library],
    ['README.md', 'Alias.so', library],
    ['../README.md', 'OutOfPackage.md', library],
    ['Main.lean', 'Alias.lean', f.project.root],
  ]) {
    const link = path.join(root, name)
    await fs.symlink(target, link)
    assert(
      (await f.store.files(f.project.id, 'alice')).every(
        ({ revision }) => revision === undefined,
      ),
      link,
    )
    await fs.unlink(link)
  }
})

test('failed file scans release their entry so a later request can retry', async (t) => {
  const f = await fixture(t)
  let calls = 0
  f.runtime.dependencyRoot = () => {
    if (++calls === 1) throw new Error('Temporary fixture dependency failure')
    return f.project.root
  }
  await assert.rejects(
    f.store.files(f.project.id, 'alice'),
    /Temporary fixture dependency failure/,
  )
  assert(
    (await f.store.files(f.project.id, 'alice')).some(
      (file) => file.path === 'Main.lean',
    ),
  )
  assert.equal(calls, 2)
})
