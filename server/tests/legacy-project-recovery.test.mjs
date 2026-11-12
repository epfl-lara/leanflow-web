import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../workspaces.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const runtime = {
  templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
  templateRoot: () => null,
  prepareToolchain: async () => {},
  async run(root, args) {
    if (args[0] === 'lake' && args.includes('update'))
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[]}',
      )
    return { code: 0, stdout: '', stderr: '' }
  },
}

async function fixture(t, { marker, manifestChange } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-legacy-'))
  let store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(project.id)
  const healthy = await store.create('bob', { preset: 'lean' })
  await store.jobs.get(healthy.id)
  const id = `${Date.now()}-${randomUUID()}`
  const directory = path.join(store.historyDir, project.id, id)
  await fs.mkdir(path.join(directory, 'before'), { recursive: true })
  await fs.mkdir(path.join(directory, 'staged'))
  const manifest = {
    projectId: project.id,
    owner: 'alice',
    createdAt: new Date().toISOString(),
    changes: [
      {
        path: 'A.lean',
        beforeHash: hash('-- original A\n'),
        afterHash: hash('-- new A\n'),
      },
      { path: 'New.lean', beforeHash: null, afterHash: hash('-- new file\n') },
      { path: 'Z.lean', beforeHash: hash('-- original Z\n'), afterHash: null },
    ],
  }
  manifestChange?.(manifest)
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify(manifest),
  )
  await fs.writeFile(path.join(directory, 'before/0'), '-- original A\n', {
    mode: 0o640,
  })
  await fs.writeFile(path.join(directory, 'before/2'), '-- original Z\n')
  await fs.writeFile(path.join(project.root, 'A.lean'), '-- new A\n')
  await fs.writeFile(path.join(project.root, 'New.lean'), '-- new file\n')
  if (marker !== undefined)
    await fs.writeFile(path.join(directory, 'applied.json'), marker)
  const reopen = async () => {
    store.close()
    store = await new WorkspaceStore({ dataDir, runtime }).init()
    return store
  }
  await reopen()
  return {
    dataDir,
    directory,
    id,
    project,
    healthy,
    reopen,
    get store() {
      return store
    },
  }
}

test('older partial updates are isolated, reviewed and restored with retained history', async (t) => {
  const f = await fixture(t)
  assert.equal(
    f.store.get(f.project.id, 'alice').legacyFileRecoveryRequired,
    true,
  )
  assert.equal(f.store.get(f.healthy.id, 'bob').status, 'ready')
  await assert.rejects(
    f.store.writeFile(
      f.project.id,
      'alice',
      'A.lean',
      'unsafe',
      hash('-- new A\n'),
    ),
    /older interrupted/i,
  )
  await f.store.writeFile(
    f.healthy.id,
    'bob',
    'Healthy.lean',
    '-- still available\n',
    null,
  )
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(review.canRestore, true)
  assert.deepEqual(
    review.files.map((file) => file.path),
    ['A.lean', 'New.lean', 'Z.lean'],
  )
  assert.equal(
    (
      await f.store.legacyRecoveryOriginal(
        f.project.id,
        'alice',
        f.id,
        'A.lean',
      )
    ).toString(),
    '-- original A\n',
  )
  let checked = 0
  const project = await f.store.resolveLegacyFileRecovery(
    f.project.id,
    'alice',
    f.id,
    { revision: review.revision, decision: 'restore' },
    {
      assertIdle() {
        checked++
      },
    },
  )
  assert.ok(checked > 1)
  assert.equal(project.status, 'ready')
  assert.equal(project.fileRecoveryRequired, undefined)
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- original A\n',
  )
  assert.equal(
    (await fs.stat(path.join(f.project.root, 'A.lean'))).mode & 0o777,
    0o640,
  )
  await assert.rejects(fs.stat(path.join(f.project.root, 'New.lean')), {
    code: 'ENOENT',
  })
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'Z.lean'), 'utf8'),
    '-- original Z\n',
  )
  assert.equal(
    await fs.readFile(path.join(f.directory, 'before/0'), 'utf8'),
    '-- original A\n',
  )
  await f.reopen()
  assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS n FROM pending_project_transactions')
      .get().n,
    0,
  )
})

test('later edits invalidate review and can only be retained with an explicit fresh choice', async (t) => {
  const f = await fixture(t)
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  await fs.writeFile(path.join(f.project.root, 'A.lean'), '-- later edit\n')
  await assert.rejects(
    f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
      revision: review.revision,
      decision: 'restore',
    }),
    { status: 409 },
  )
  const {
    reviews: [fresh],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(fresh.canRestore, false)
  assert.equal(fresh.files[0].changedAfterUpdate, true)
  await assert.rejects(
    f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
      revision: fresh.revision,
      decision: 'restore',
    }),
    { status: 409 },
  )
  await f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
    revision: fresh.revision,
    decision: 'keep-current',
  })
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- later edit\n',
  )
  await f.reopen()
  assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
  assert.equal(
    await fs.readFile(path.join(f.directory, 'before/0'), 'utf8'),
    '-- original A\n',
  )
})

test('Editors, Viewers and removed Admins cannot review, download or resolve private recovery', async (t) => {
  const f = await fixture(t)
  f.store.memberships.set(f.project, 'editor', 'editor')
  f.store.memberships.set(f.project, 'viewer', 'viewer')
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  for (const actor of ['editor', 'viewer', 'outsider']) {
    const status = actor === 'outsider' ? 404 : 403
    await assert.rejects(f.store.legacyFileRecovery(f.project.id, actor), {
      status,
    })
    await assert.rejects(
      f.store.legacyRecoveryOriginal(f.project.id, actor, f.id, 'A.lean'),
      { status },
    )
    await assert.rejects(
      f.store.resolveLegacyFileRecovery(f.project.id, actor, f.id, {
        revision: review.revision,
        decision: 'keep-current',
      }),
      { status },
    )
  }
  f.store.memberships.set(f.project, 'bob', 'admin')
  f.store.memberships.set(f.project, 'alice', 'editor')
  await assert.rejects(
    f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
      revision: review.revision,
      decision: 'restore',
    }),
    { status: 403 },
  )
  await f.store.resolveLegacyFileRecovery(f.project.id, 'bob', f.id, {
    revision: review.revision,
    decision: 'restore',
  })
})

test('active work refuses recovery without stopping it or changing any file', async (t) => {
  const f = await fixture(t)
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  await assert.rejects(
    f.store.resolveLegacyFileRecovery(
      f.project.id,
      'alice',
      f.id,
      { revision: review.revision, decision: 'restore' },
      {
        assertIdle() {
          throw Object.assign(new Error('Collaborator work is active'), {
            status: 409,
          })
        },
      },
    ),
    { status: 409 },
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- new A\n',
  )
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
})

test('completed older histories and versioned staging are not falsely quarantined', async (t) => {
  const f = await fixture(t, {
    marker: JSON.stringify({ appliedAt: new Date().toISOString() }),
  })
  assert.equal(
    f.store.get(f.project.id, 'alice').fileRecoveryRequired,
    undefined,
  )
  const g = await fixture(t, {
    manifestChange(manifest) {
      manifest.version = 1
    },
  })
  assert.equal(
    g.store.get(g.project.id, 'alice').fileRecoveryRequired,
    undefined,
  )
})

test('truncated completion marker still permits safe explicit recovery', async (t) => {
  const f = await fixture(t, { marker: '{"appliedAt":' })
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(review.canRestore, true)
  await f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
    revision: review.revision,
    decision: 'restore',
  })
})

test('changed originals and source symlinks cannot escape recovery containment', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.directory, 'before/0'), 'corrupt')
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(review.canRestore, false)
  await assert.rejects(
    f.store.legacyRecoveryOriginal(f.project.id, 'alice', f.id, 'A.lean'),
    /integrity/,
  )
  const secret = path.join(f.dataDir, 'outside.lean')
  await fs.writeFile(secret, 'outside private data')
  await fs.unlink(path.join(f.project.root, 'A.lean'))
  await fs.symlink(secret, path.join(f.project.root, 'A.lean'))
  const {
    reviews: [unsafe],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(unsafe.canRestore, false)
  assert.equal(unsafe.revision, null)
  assert.equal(JSON.stringify(unsafe).includes('outside private data'), false)
  assert.equal(await fs.readFile(secret, 'utf8'), 'outside private data')
})

test('malformed legacy paths are never read or written and can be dismissed without deleting history', async (t) => {
  const f = await fixture(t, {
    manifestChange(manifest) {
      manifest.changes[0].path = '../outside.lean'
    },
  })
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(review.canRestore, false)
  assert.deepEqual(review.files, [])
  await f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
    revision: review.revision,
    decision: 'keep-current',
  })
  assert.equal(f.store.get(f.project.id, 'alice').needsPreparation, true)
  assert.equal(
    f.store.get(f.project.id, 'alice').fileRecoveryRequired,
    undefined,
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- new A\n',
  )
  assert.ok((await fs.stat(f.directory)).isDirectory())
})

for (const bytes of [Buffer.from([0x61, 0, 0x62]), Buffer.from([0xff, 0xfe])])
  test(`non-text originals are downloadable but automatic restore is refused (${bytes.toString('hex')})`, async (t) => {
    const f = await fixture(t)
    const manifestPath = path.join(f.directory, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    manifest.changes[0].beforeHash = hash(bytes)
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    await fs.writeFile(path.join(f.directory, 'before/0'), bytes)
    const {
      reviews: [review],
    } = await f.store.legacyFileRecovery(f.project.id, 'alice')
    assert.equal(review.canRestore, false)
    await assert.rejects(
      f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
        revision: review.revision,
        decision: 'restore',
      }),
      { status: 409 },
    )
    assert.deepEqual(
      await f.store.legacyRecoveryOriginal(
        f.project.id,
        'alice',
        f.id,
        'A.lean',
      ),
      bytes,
    )
    assert.equal(
      await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
      '-- new A\n',
    )
  })

test('UTF-8 spanning stream chunks restores exactly and preview binds original permissions', async (t) => {
  const f = await fixture(t)
  const original = '-- ' + 'x'.repeat(65533) + 'λ\n'
  const manifestPath = path.join(f.directory, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.changes[0].beforeHash = hash(original)
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  await fs.writeFile(path.join(f.directory, 'before/0'), original)
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(review.canRestore, true)
  await fs.chmod(path.join(f.directory, 'before/0'), 0o600)
  await assert.rejects(
    f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
      revision: review.revision,
      decision: 'restore',
    }),
    { status: 409 },
  )
  const {
    reviews: [fresh],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  await f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
    revision: fresh.revision,
    decision: 'restore',
  })
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    original,
  )
})

test('keeping changed configuration persists preparation requirements across restart', async (t) => {
  const f = await fixture(t, {
    manifestChange(manifest) {
      manifest.changes[0].path = 'lakefile.toml'
    },
  })
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  await f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
    revision: review.revision,
    decision: 'keep-current',
  })
  assert.equal(f.store.get(f.project.id, 'alice').needsPreparation, true)
  assert.equal(
    f.store.get(f.project.id, 'alice').fileRecoveryRequired,
    undefined,
  )
  await f.reopen()
  assert.equal(f.store.get(f.project.id, 'alice').needsPreparation, true)
  assert.equal(
    f.store.get(f.project.id, 'alice').fileRecoveryRequired,
    undefined,
  )
})

test('a crash after restored files but before recording the choice is recognized without changing source again', async (t) => {
  const f = await fixture(t)
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  const prepare = f.store.db.prepare.bind(f.store.db)
  t.mock.method(f.store.db, 'prepare', (sql) => {
    if (sql.startsWith('INSERT INTO legacy_transaction_resolutions'))
      throw new Error('Fixture interrupted decision record')
    return prepare(sql)
  })
  await assert.rejects(
    f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
      revision: review.revision,
      decision: 'restore',
    }),
    /interrupted decision/,
  )
  t.mock.restoreAll()
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- original A\n',
  )
  await f.reopen()
  const page = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(page.totalRecords, 0)
  assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
})

for (const method of ['list', 'original'])
  test(`account removal during recovery ${method} prevents returning private data`, async (t) => {
    const f = await fixture(t)
    let active = true
    f.store.assertActorActive = () => {
      if (!active)
        throw Object.assign(
          new Error('Account access is no longer available.'),
          { status: 404 },
        )
    }
    const original = f.store.legacyRecovery[method].bind(f.store.legacyRecovery)
    t.mock.method(f.store.legacyRecovery, method, async (...args) => {
      const result = await original(...args)
      active = false
      return result
    })
    await assert.rejects(
      method === 'list'
        ? f.store.legacyFileRecovery(f.project.id, 'alice')
        : f.store.legacyRecoveryOriginal(f.project.id, 'alice', f.id, 'A.lean'),
      { status: 404 },
    )
  })

test('fixing unavailable history enables in-process review without clearing unresolved work', async (t) => {
  const f = await fixture(t)
  const directory = path.dirname(f.directory)
  const retained = path.join(f.dataDir, 'retained-history-backup')
  await fs.rename(directory, retained)
  await fs.symlink(retained, directory)
  await f.reopen()
  const unavailable = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(unavailable.reviews[0].revision, null)
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  await fs.unlink(directory)
  await fs.rename(retained, directory)
  const {
    reviews: [review],
  } = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(review.id, f.id)
  assert.equal(review.canRestore, true)
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  await f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
    revision: review.revision,
    decision: 'keep-current',
  })
  assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
  assert.equal(f.store.get(f.healthy.id, 'bob').status, 'ready')
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- new A\n',
  )
  assert.equal(
    await fs.readFile(path.join(f.directory, 'before/0'), 'utf8'),
    '-- original A\n',
  )
})

test('a repaired history with only committed records clears a temporary storage guard without restart', async (t) => {
  const f = await fixture(t, {
    marker: JSON.stringify({ appliedAt: new Date().toISOString() }),
  })
  const directory = path.dirname(f.directory)
  const retained = path.join(f.dataDir, 'committed-history-backup')
  await fs.rename(directory, retained)
  await fs.symlink(retained, directory)
  await f.reopen()
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  await fs.unlink(directory)
  await fs.rename(retained, directory)
  const changes = []
  const unsubscribe = f.store.subscribeChanges((event) => changes.push(event))
  const page = await f.store.legacyFileRecovery(f.project.id, 'alice')
  unsubscribe()
  assert.equal(page.totalRecords, 0)
  assert.deepEqual(page.reviews, [])
  assert.equal(
    f.store.get(f.project.id, 'alice').fileRecoveryRequired,
    undefined,
  )
  assert.equal(
    changes.filter(
      (event) => event.projectId === f.project.id && event.kind === 'project',
    ).length,
    1,
  )
  assert.equal(f.store.get(f.healthy.id, 'bob').status, 'ready')
})

test('a known interrupted update remains guarded if its manifest disappears', async (t) => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.directory, 'manifest.json'))
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await f.store.legacyFileRecovery(f.project.id, 'alice')
    assert.equal(page.totalRecords, 1)
    assert.equal(page.reviews[0].id, f.id)
    assert.equal(page.reviews[0].revision, null)
    assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  }
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- new A\n',
  )
  assert.equal(
    await fs.readFile(path.join(f.directory, 'before/0'), 'utf8'),
    '-- original A\n',
  )
})

test('review pages bound files and records while one revision binds every affected file', async (t) => {
  const f = await fixture(t)
  const manifest = JSON.parse(
    await fs.readFile(path.join(f.directory, 'manifest.json'), 'utf8'),
  )
  manifest.changes = Array.from({ length: 205 }, (_, index) => ({
    path: `File${String(index).padStart(3, '0')}.lean`,
    beforeHash: null,
    afterHash: hash(''),
  }))
  await Promise.all(
    manifest.changes.map((change) =>
      fs.writeFile(path.join(f.project.root, change.path), ''),
    ),
  )
  await fs.writeFile(
    path.join(f.directory, 'manifest.json'),
    JSON.stringify(manifest),
  )
  for (let index = 1; index <= 6; index++) {
    const id = `${Number(f.id.slice(0, 13)) + index}-${randomUUID()}`
    await fs.cp(f.directory, path.join(path.dirname(f.directory), id), {
      recursive: true,
    })
  }
  await f.reopen()
  const first = await f.store.legacyFileRecovery(f.project.id, 'alice')
  assert.equal(first.totalRecords, 7)
  assert.equal(first.reviews.length, 5)
  assert.equal(first.reviews[0].files.length, 100)
  assert.equal(first.reviews[0].fileCount, 205)
  assert.equal(first.reviews[0].nextFileOffset, 100)
  assert.equal(first.reviews[0].files[0].path, 'File000.lean')
  assert.equal('manifestHash' in first.reviews[0], false)
  assert.equal('prepared' in first.reviews[0], false)
  const secondFiles = await f.store.legacyFileRecovery(f.project.id, 'alice', {
    recordId: f.id,
    fileOffset: 100,
  })
  assert.equal(secondFiles.reviews.length, 1)
  assert.equal(secondFiles.reviews[0].files[0].path, 'File100.lean')
  assert.equal(secondFiles.reviews[0].revision, first.reviews[0].revision)
  const finalFiles = await f.store.legacyFileRecovery(f.project.id, 'alice', {
    recordId: f.id,
    fileOffset: 200,
  })
  assert.equal(finalFiles.reviews[0].files.length, 5)
  assert.equal(finalFiles.reviews[0].nextFileOffset, null)
  assert.equal(finalFiles.reviews[0].revision, first.reviews[0].revision)
  await f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
    revision: first.reviews[0].revision,
    decision: 'keep-current',
  })
  const secondRecords = await f.store.legacyFileRecovery(
    f.project.id,
    'alice',
    { cursor: first.nextCursor },
  )
  assert.equal(secondRecords.reviews.length, 2)
  assert.equal(secondRecords.nextCursor, null)
  assert.equal(secondRecords.totalRecords, 6)
  assert.ok(secondRecords.reviews.every((item) => item.id > first.nextCursor))
})

test('one shared review deadline stops the page without blocking sharing or changing files', async (t) => {
  const f = await fixture(t)
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let calls = 0
  t.mock.method(
    f.store.legacyRecovery,
    'review',
    async (_project, _id, { signal }) => {
      calls++
      entered()
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000)
        const abort = () => {
          clearTimeout(timer)
          reject(signal.reason)
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
  )
  const waiting = f.store.legacyFileRecovery(f.project.id, 'alice', {
    signal: AbortSignal.timeout(50),
  })
  const rejected = assert.rejects(waiting, { status: 408 })
  await started
  await f.store.setMember(f.project.id, 'alice', 'bob', 'viewer')
  assert.equal(f.store.get(f.project.id, 'bob').accessRole, 'viewer')
  await rejected
  assert.equal(calls, 1)
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- new A\n',
  )
  t.mock.restoreAll()
  assert.equal(
    (await f.store.legacyFileRecovery(f.project.id, 'alice')).reviews[0]
      .canRestore,
    true,
  )
})

test('valid JSON with an invalid legacy manifest shape is reviewable without guessing file paths', async (t) => {
  for (const value of [null, [], 12, 'invalid']) {
    const f = await fixture(t)
    await fs.writeFile(
      path.join(f.directory, 'manifest.json'),
      JSON.stringify(value),
    )
    const {
      reviews: [review],
    } = await f.store.legacyFileRecovery(f.project.id, 'alice')
    assert.equal(review.canRestore, false)
    assert.deepEqual(review.files, [])
    assert.equal(typeof review.revision, 'string')
    await f.store.resolveLegacyFileRecovery(f.project.id, 'alice', f.id, {
      revision: review.revision,
      decision: 'keep-current',
    })
    assert.equal(
      f.store.get(f.project.id, 'alice').fileRecoveryRequired,
      undefined,
    )
    assert.equal(
      await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
      '-- new A\n',
    )
  }
})

test('all-original legacy records remain usable without a manual recovery choice or source mutation', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.project.root, 'A.lean'), '-- original A\n')
  await fs.unlink(path.join(f.project.root, 'New.lean'))
  await fs.writeFile(path.join(f.project.root, 'Z.lean'), '-- original Z\n')
  await f.reopen()
  assert.equal(
    f.store.get(f.project.id, 'alice').fileRecoveryRequired,
    undefined,
  )
  assert.equal(
    (await f.store.legacyFileRecovery(f.project.id, 'alice')).totalRecords,
    0,
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'A.lean'), 'utf8'),
    '-- original A\n',
  )
  assert.equal(
    await fs.readFile(path.join(f.directory, 'before/0'), 'utf8'),
    '-- original A\n',
  )
  assert.equal(
    f.store.db
      .prepare(
        'SELECT decision FROM legacy_transaction_resolutions WHERE project=? AND id=?',
      )
      .get(f.project.id, f.id).decision,
    'unchanged',
  )
  await f.reopen()
  assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
  assert.equal(f.store.get(f.healthy.id, 'bob').status, 'ready')
})

test('hundreds of committed and versioned histories stay healthy despite a tiny source-classification budget', async (t) => {
  const f = await fixture(t, {
    marker: JSON.stringify({ appliedAt: new Date().toISOString() }),
  })
  const manifest = JSON.parse(
    await fs.readFile(path.join(f.directory, 'manifest.json'), 'utf8'),
  )
  for (let index = 1; index <= 200; index++) {
    const id = `${Number(f.id.slice(0, 13)) + index}-${randomUUID()}`
    const directory = path.join(path.dirname(f.directory), id)
    await fs.mkdir(directory)
    await fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify(index % 2 ? { ...manifest, version: 2 } : manifest),
    )
    if (index % 2 === 0)
      await fs.writeFile(
        path.join(directory, 'applied.json'),
        JSON.stringify({ appliedAt: new Date().toISOString() }),
      )
  }
  f.store.legacyRecovery.startupClassificationMs = 1
  await f.store.legacyRecovery.init([f.project, f.healthy])
  assert.equal(
    f.store.get(f.project.id, 'alice').fileRecoveryRequired,
    undefined,
  )
  assert.equal(
    f.store.get(f.project.id, 'alice').legacyRecoveryReviewAvailable,
    undefined,
  )
  assert.equal(
    (await f.store.legacyFileRecovery(f.project.id, 'alice')).totalRecords,
    0,
  )
  assert.equal(f.store.get(f.healthy.id, 'bob').status, 'ready')
})

test('exhausting the shared startup metadata budget defers unknown history without pausing healthy projects', async (t) => {
  const f = await fixture(t)
  await f.store.legacyRecovery.init([f.project, f.healthy], {
    signal: AbortSignal.abort(),
  })
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  assert.equal(f.store.get(f.healthy.id, 'bob').fileRecoveryRequired, undefined)
  assert.equal(
    f.store.get(f.healthy.id, 'bob').legacyRecoveryReviewAvailable,
    true,
  )
  const page = await f.store.legacyFileRecovery(f.healthy.id, 'bob')
  assert.equal(page.totalRecords, 0)
  assert.equal(page.scanDeferred, false)
  assert.equal(
    f.store.get(f.healthy.id, 'bob').legacyRecoveryReviewAvailable,
    undefined,
  )
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
})

test('slow all-before classification defers only the unmarked update and leaves other projects available', async (t) => {
  const f = await fixture(t)
  const original = Buffer.alloc(4 * 1024 * 1024, 'a')
  const manifestFile = path.join(f.directory, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  manifest.changes[0].beforeHash = hash(original)
  await fs.writeFile(manifestFile, JSON.stringify(manifest))
  await fs.writeFile(path.join(f.project.root, 'A.lean'), original)
  await fs.writeFile(path.join(f.directory, 'before/0'), original)
  f.store.legacyRecovery.startupClassificationMs = 1
  await f.store.legacyRecovery.init([f.project, f.healthy])
  assert.equal(f.store.get(f.project.id, 'alice').fileRecoveryRequired, true)
  assert.equal(f.store.get(f.healthy.id, 'bob').fileRecoveryRequired, undefined)
  assert.equal(
    f.store.get(f.healthy.id, 'bob').legacyRecoveryReviewAvailable,
    undefined,
  )
  assert.equal(
    (await fs.stat(path.join(f.project.root, 'A.lean'))).size,
    original.length,
  )
})
