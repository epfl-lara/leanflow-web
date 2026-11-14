import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { WorkspaceStore } from '../workspaces.mjs'
import { createProjectDownload } from '../project-downloads.mjs'

test('a fresh store recovers a delayed displaced-inode write into the caller-only ZIP before discard', async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-terminal-crash-'),
  )
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args) {
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true })
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      }
      return { code: 0, stdout: 'Lean version 4.34.1\n', stderr: '' }
    },
  }
  let store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', {
    preset: 'lean',
    name: 'Crash recovery fixture',
  })
  await store.jobs.get(project.id)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const snapshot = await store.terminalSnapshot(
    project.id,
    'bob',
    'crash-displaced-write',
  )
  const original = await store.readFile(project.id, 'alice', 'Main.lean')
  const old = await fs.open(path.join(snapshot.root, 'Main.lean'), 'r+')
  let metadata
  try {
    await store.writeFile(
      project.id,
      'alice',
      'Main.lean',
      '-- current browser text\n',
      original.hash,
    )
    await store.syncTerminal(snapshot)
    const directory = path.join(
      path.dirname(snapshot.root),
      'terminal-pull-backups',
    )
    const filenames = (await fs.readdir(directory)).filter((filename) =>
      filename.endsWith('.json'),
    )
    assert.equal(filenames.length, 1)
    metadata = JSON.parse(
      await fs.readFile(path.join(directory, filenames[0]), 'utf8'),
    )
    assert.equal(
      metadata.path,
      'Main.lean',
      'the original path is durable before the late write',
    )
    await old.truncate(0)
    await old.writeFile('-- terminal write after the last coordinator poll\n')
  } finally {
    await old.close()
  }
  await store.setMember(project.id, 'alice', 'bob', 'viewer')
  store.close()
  store = await new WorkspaceStore({ dataDir, runtime }).init()
  await assert.rejects(
    store.terminalRecovery(project.id, 'alice', snapshot.runId),
    { status: 404 },
  )
  const recovery = await store.terminalRecovery(
    project.id,
    'bob',
    snapshot.runId,
  )
  const files = {
    get: () => recovery,
    readDownloadFile: (_id, _actor, filename, options) =>
      store.readTerminalRecoveryFile(
        project.id,
        'bob',
        snapshot.runId,
        filename,
        options,
      ),
  }
  const download = await createProjectDownload(files, project.id, 'bob')
  const zip = await JSZip.loadAsync(download.content)
  const recovered = Object.keys(zip.files).filter(
    (filename) =>
      filename.startsWith('.terminal-sync-recovery/') &&
      filename.endsWith('/Main.lean'),
  )
  assert.equal(recovered.length, 1)
  assert.equal(
    await zip.file(recovered[0]).async('string'),
    '-- terminal write after the last coordinator poll\n',
  )
  assert.equal(
    await zip.file('Main.lean').async('string'),
    '-- current browser text\n',
  )
  await store.terminalRecovery(project.id, 'bob', snapshot.runId)
  await assert.rejects(
    fs.stat(path.join(path.dirname(snapshot.root), metadata.filename)),
    { code: 'ENOENT' },
  )
  assert.deepEqual(
    await store.deleteTerminalRecovery(project.id, 'bob', snapshot.runId),
    { removed: true, runId: snapshot.runId },
  )
  await assert.rejects(fs.stat(path.dirname(snapshot.root)), { code: 'ENOENT' })
})
