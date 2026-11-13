import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { createStudio } from '../studio.mjs'
import { JobManager } from '../events.mjs'
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
  async spawn(root) {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.workerHome = await fs.mkdtemp(
      path.join(path.dirname(root), 'terminal-home-'),
    )
    child.kill = () => {
      if (child.killed) return
      child.killed = true
      queueMicrotask(() => {
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0)
      })
    }
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
    url,
    tokens,
  }
}

const write = (f, name, content = '-- ' + name + '\n') =>
  f.store.writeFile(f.project.id, 'owner', name, content, null)

async function sharedClient(t, f, actor) {
  const ws = new WebSocket(
    `${f.url.replace('http:', 'ws:')}/websocket/collaboration/${f.project.id}`,
    { headers: { Authorization: `Bearer ${f.tokens[actor]}` } },
  )
  const packets = [],
    documents = new Map(),
    allDocuments = []
  let requestId = 0,
    socketError
  ws.on('error', (error) => {
    socketError = error
  })
  ws.on('message', (data) => {
    const packet = JSON.parse(data.toString())
    packets.push(packet)
    if (packet.type !== 'document') return
    let document = documents.get(packet.path)
    if (document?.id !== packet.documentId) {
      document = { id: packet.documentId, doc: new Y.Doc() }
      documents.set(packet.path, document)
      allDocuments.push(document.doc)
    }
    Y.applyUpdate(
      document.doc,
      new Uint8Array(Buffer.from(packet.update, 'base64')),
    )
  })
  t.after(() => {
    ws.terminate()
    for (const document of allDocuments) document.destroy()
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const wait = async (predicate, description) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (socketError) throw socketError
      const result = predicate()
      if (result) return result
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`Timed out waiting for ${description}`)
  }
  const text = (filename) =>
    documents.get(filename)?.doc.getText('source').toString()
  const open = async (filename) => {
    const id = ++requestId
    ws.send(JSON.stringify({ type: 'open', path: filename, requestId: id }))
    await wait(
      () =>
        packets.find(
          (packet) => packet.type === 'document' && packet.openRequestId === id,
        ),
      `shared file ${filename}`,
    )
    return documents.get(filename)
  }
  const edit = (filename, content) => {
    const document = documents.get(filename)
    const vector = Y.encodeStateVector(document.doc)
    const source = document.doc.getText('source')
    source.insert(source.length, content)
    return {
      type: 'update',
      path: filename,
      documentId: document.id,
      requestId: ++requestId,
      update: Buffer.from(Y.encodeStateAsUpdate(document.doc, vector)).toString(
        'base64',
      ),
    }
  }
  const send = (packet) => ws.send(JSON.stringify(packet))
  return { ws, packets, documents, wait, text, open, edit, send }
}

test('request parsing and path rules reject malformed and self-containing moves', () => {
  assert.deepEqual(parseMoveRequest({ from: 'a', to: 'b' }), {
    from: 'a',
    to: 'b',
  })
  for (const updateReferences of [true, false])
    assert.deepEqual(
      parseMoveRequest({ from: 'a', to: 'b', updateReferences }),
      {
        from: 'a',
        to: 'b',
        updateReferences,
      },
    )
  for (const body of [null, [], {}, { from: 'a' }, { from: 1, to: 'b' }])
    assert.throws(() => parseMoveRequest(body), { status: 400 })
  assert.throws(() => parseMoveRequest({ from: 'a', to: 'b', force: true }), {
    status: 400,
  })
  for (const updateReferences of [null, 0, 'true', {}, []])
    assert.throws(
      () => parseMoveRequest({ from: 'a', to: 'b', updateReferences }),
      { status: 400 },
    )
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

test('one request can change both the folder and name of a file or folder', async (t) => {
  const f = await fixture(t)
  await write(f, 'Source/Old.lean', '-- moved file\n')
  await write(f, 'Source/Examples/Child.lean', '-- moved folder\n')
  await fs.mkdir(path.join(f.project.root, 'Destination'))
  for (const [from, to, kind, filename, content] of [
    ['Source/Old.lean', 'Destination/New.lean', 'file', '', '-- moved file\n'],
    [
      'Source/Examples',
      'Destination/Archive',
      'folder',
      '/Child.lean',
      '-- moved folder\n',
    ],
  ]) {
    const response = await f.move({ from, to })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { from, to, kind })
    assert.equal(
      (await f.store.readFile(f.project.id, 'owner', to + filename)).content,
      content,
    )
    await assert.rejects(fs.stat(path.join(f.project.root, from)), {
      code: 'ENOENT',
    })
  }
})

test('moving an asset can update Lean documentation, Markdown and TeX references', async (t) => {
  const f = await fixture(t)
  const asset = '<svg><!-- preserve image bytes --></svg>\n'
  await write(f, 'Problems/Figure.svg', asset)
  await write(f, 'Problems/Problem.lean', '/-!\n![Figure](Figure.svg)\n-/\n')
  await write(f, 'README.md', '![Figure](Problems/Figure.svg)\n')
  await write(f, 'Notes.tex', '\\includegraphics{Problems/Figure.svg}\n')
  await fs.mkdir(path.join(f.project.root, 'Problems/figures'))
  await fs.chmod(path.join(f.project.root, 'Problems/Figure.svg'), 0o640)
  const before = await fs.stat(path.join(f.project.root, 'Problems/Figure.svg'))
  const notifications = []
  f.store.subscribeChanges((event) => notifications.push(event))
  const response = await f.move({
    from: 'Problems/Figure.svg',
    to: 'Problems/figures/Figure.svg',
    updateReferences: true,
  })
  assert.equal(response.status, 200)
  const moved = await response.json()
  assert.deepEqual(moved.references, {
    updatedFiles: 3,
    updatedReferences: 3,
    updatedPaths: ['Notes.tex', 'Problems/Problem.lean', 'README.md'],
    skippedFiles: 0,
  })
  for (const filename of moved.references.updatedPaths)
    assert(
      notifications.some((event) => event.paths.includes(filename)),
      `Live editors must learn about the changed reference in ${filename}`,
    )
  assert(
    notifications.some((event) =>
      event.moves?.some(
        (move) => move.from === moved.from && move.to === moved.to,
      ),
    ),
  )
  const after = await fs.stat(
    path.join(f.project.root, 'Problems/figures/Figure.svg'),
  )
  assert.equal(after.ino, before.ino)
  assert.equal(after.mode & 0o777, 0o640)
  for (const [filename, content] of [
    ['Problems/Problem.lean', '/-!\n![Figure](figures/Figure.svg)\n-/\n'],
    ['README.md', '![Figure](Problems/figures/Figure.svg)\n'],
    ['Notes.tex', '\\includegraphics{Problems/figures/Figure.svg}\n'],
    ['Problems/figures/Figure.svg', asset],
  ])
    assert.equal(
      (await f.store.readFile(f.project.id, 'owner', filename)).content,
      content,
      filename,
    )
})

test('a shared editor asset move broadcasts reference updates and preserves another client’s unacknowledged typing', async (t) => {
  const f = await fixture(t)
  await write(f, 'Problems/Figure.svg', '<svg/>\n')
  await write(f, 'Problems/Problem.lean', '/-!\n![Figure](Figure.svg)\n-/\n')
  await fs.mkdir(path.join(f.project.root, 'Problems/figures'))
  const owner = await sharedClient(t, f, 'owner')
  const editor = await sharedClient(t, f, 'editor')
  for (const client of [owner, editor])
    await client.open('Problems/Problem.lean')
  const pending = owner.edit(
    'Problems/Problem.lean',
    '-- owner is still typing\n',
  )
  const response = await f.move(
    {
      from: 'Problems/Figure.svg',
      to: 'Problems/figures/Figure.svg',
      updateReferences: true,
    },
    'editor',
  )
  assert.equal(response.status, 200)
  assert.equal((await response.json()).references.updatedFiles, 1)
  for (const client of [owner, editor])
    await client.wait(
      () =>
        client.text('Problems/Problem.lean')?.includes('](figures/Figure.svg)'),
      'the updated shared image reference',
    )
  assert.match(owner.text('Problems/Problem.lean'), /owner is still typing/)
  assert(!owner.packets.some((packet) => packet.ack === pending.requestId))
  owner.send(pending)
  await owner.wait(
    () => owner.packets.find((packet) => packet.ack === pending.requestId),
    'the acknowledgement of the preserved local edit',
  )
  const expected =
    '/-!\n![Figure](figures/Figure.svg)\n-/\n-- owner is still typing\n'
  for (const client of [owner, editor])
    await client.wait(
      () => client.text('Problems/Problem.lean') === expected,
      'both shared clients to converge',
    )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Problems/Problem.lean'))
      .content,
    expected,
  )
  assert.equal(owner.ws.readyState, WebSocket.OPEN)
  assert.equal(editor.ws.readyState, WebSocket.OPEN)
})

test('shared folder moves retire stale documents, merge pending reference edits and reject revoked writers', async (t) => {
  const f = await fixture(t)
  await write(f, 'Examples/Helper.lean', '-- helper\n')
  await write(f, 'Examples/Proof.lean', 'import Examples.Helper\n')
  await write(f, 'Outside.lean', 'import Examples.Proof\n')
  await fs.mkdir(path.join(f.project.root, 'Archive'))
  const owner = await sharedClient(t, f, 'owner')
  const editor = await sharedClient(t, f, 'editor')
  await owner.open('Outside.lean')
  await editor.open('Examples/Proof.lean')
  const pending = owner.edit('Outside.lean', '-- owner pending\n')
  const stale = editor.edit('Examples/Proof.lean', '-- stale old path\n')
  const response = await f.move(
    {
      from: 'Examples',
      to: 'Archive/Renamed',
      updateReferences: true,
    },
    'editor',
  )
  assert.equal(response.status, 200)
  for (const client of [owner, editor])
    await client.wait(
      () =>
        client.packets.some((packet) =>
          packet.moves?.some(
            (move) => move.from === 'Examples' && move.to === 'Archive/Renamed',
          ),
        ),
      'the shared folder move announcement',
    )
  await owner.wait(
    () => owner.text('Outside.lean')?.includes('import Archive.Renamed.Proof'),
    'the rewritten shared import',
  )
  owner.send(pending)
  await owner.wait(
    () => owner.packets.find((packet) => packet.ack === pending.requestId),
    'the pending shared edit acknowledgement',
  )
  editor.send(stale)
  const rejected = await editor.wait(
    () =>
      editor.packets.find(
        (packet) =>
          packet.type === 'error' && packet.requestId === stale.requestId,
      ),
    'the retired document rejection',
  )
  assert.equal(rejected.status, 409)
  const current = await editor.open('Archive/Renamed/Proof.lean')
  assert.notEqual(current.id, stale.documentId)
  assert.equal(
    editor.text('Archive/Renamed/Proof.lean'),
    'import Archive.Renamed.Helper\n',
  )
  const revoked = editor.edit(
    'Archive/Renamed/Proof.lean',
    '-- revoked write\n',
  )
  const record = f.projectDocuments.documents.get(
    f.projectDocuments.key(f.project.id, 'Archive/Renamed/Proof.lean'),
  )
  let release
  const held = f.projectDocuments.queue(
    record,
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  try {
    await editor.wait(() => release, 'the held shared document queue')
    editor.send(revoked)
    await editor.wait(() => record.pending >= 2, 'the queued editor update')
    await f.store.removeMember(f.project.id, 'owner', 'editor')
    await editor.wait(
      () => editor.ws.readyState === WebSocket.CLOSED,
      'the revoked socket closure',
    )
  } finally {
    release?.()
    await held
  }
  await owner.wait(
    () => record.pending === 0,
    'the revoked update to be checked',
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Outside.lean')).content,
    'import Archive.Renamed.Proof\n-- owner pending\n',
  )
  assert.equal(
    (
      await f.store.readFile(
        f.project.id,
        'owner',
        'Archive/Renamed/Proof.lean',
      )
    ).content,
    'import Archive.Renamed.Helper\n',
  )
  await assert.rejects(fs.stat(path.join(f.project.root, 'Examples')), {
    code: 'ENOENT',
  })
  assert.equal(
    (
      await f.move(
        { from: 'Archive/Renamed', to: 'Examples', updateReferences: true },
        'editor',
      )
    ).status,
    404,
  )
  assert.equal(owner.ws.readyState, WebSocket.OPEN)
})

test('folder moves update module imports and rebase references inside and outside the folder', async (t) => {
  const f = await fixture(t)
  await write(f, 'assets/plot.svg', '<svg/>\n')
  await write(f, 'Examples/Helper.lean', '-- helper\n')
  await write(
    f,
    'Examples/Proof.lean',
    'import Examples.Helper\n/-!\n![Plot](../assets/plot.svg)\n[Notes](Notes.md)\n-/\n',
  )
  await write(
    f,
    'Examples/Notes.md',
    '![Plot](../assets/plot.svg)\n[Proof](Proof.lean)\n',
  )
  await write(f, 'Outside.lean', 'import Examples.Proof\n')
  await write(f, 'README.md', '[Notes](Examples/Notes.md)\n')
  await write(f, 'Examples/Document.tex', 'A moved document.\n')
  await write(f, 'Notes.tex', '\\input{Examples/Document}\n')
  await fs.mkdir(path.join(f.project.root, 'Archive'))
  const response = await f.move({
    from: 'Examples',
    to: 'Archive/Renamed',
    updateReferences: true,
  })
  assert.equal(response.status, 200)
  const moved = await response.json()
  assert.equal(moved.kind, 'folder')
  assert.deepEqual(moved.references, {
    updatedFiles: 5,
    updatedReferences: 6,
    updatedPaths: [
      'Archive/Renamed/Notes.md',
      'Archive/Renamed/Proof.lean',
      'Notes.tex',
      'Outside.lean',
      'README.md',
    ],
    skippedFiles: 0,
  })
  for (const [filename, content] of [
    [
      'Archive/Renamed/Proof.lean',
      'import Archive.Renamed.Helper\n/-!\n![Plot](../../assets/plot.svg)\n[Notes](Notes.md)\n-/\n',
    ],
    [
      'Archive/Renamed/Notes.md',
      '![Plot](../../assets/plot.svg)\n[Proof](Proof.lean)\n',
    ],
    ['Outside.lean', 'import Archive.Renamed.Proof\n'],
    ['README.md', '[Notes](Archive/Renamed/Notes.md)\n'],
    ['Notes.tex', '\\input{Archive/Renamed/Document}\n'],
  ])
    assert.equal(
      (await f.store.readFile(f.project.id, 'owner', filename)).content,
      content,
      filename,
    )
})

test('reference updates are opt-in for API callers and opting out preserves every reference', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.svg', '<svg/>\n')
  await write(f, 'README.md', '![Figure](A.svg)\n')
  for (const option of [{}, { updateReferences: false }]) {
    const response = await f.move({ from: 'A.svg', to: 'B.svg', ...option })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      from: 'A.svg',
      to: 'B.svg',
      kind: 'file',
    })
    assert.equal(
      (await f.store.readFile(f.project.id, 'owner', 'README.md')).content,
      '![Figure](A.svg)\n',
    )
    assert.equal((await f.move({ from: 'B.svg', to: 'A.svg' })).status, 200)
  }
})

test('reference updates leave secret, dependency, setup and linked files untouched', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.svg', '<svg/>\n')
  await write(f, 'Normal.md', '![Figure](A.svg)\n')
  await fs.mkdir(path.join(f.project.root, 'Figures'))
  const protectedFiles = [
    '.git/Notes.md',
    '.lake/packages/dep/README.md',
    'node_modules/pkg/README.md',
    '.config/Notes.md',
    '.env.notes.md',
    'lakefile.lean',
  ]
  for (const filename of protectedFiles) {
    await fs.mkdir(path.dirname(path.join(f.project.root, filename)), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(f.project.root, filename),
      '/-!\n![Figure](A.svg)\n-/\n',
    )
  }
  const outside = path.join(f.dataDir, 'outside.md')
  await fs.writeFile(outside, '![Figure](A.svg)\n')
  await fs.symlink(outside, path.join(f.project.root, 'Linked.md'))
  const response = await f.move({
    from: 'A.svg',
    to: 'Figures/A.svg',
    updateReferences: true,
  })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).references.updatedPaths, [
    'Normal.md',
  ])
  for (const filename of protectedFiles)
    assert.equal(
      await fs.readFile(path.join(f.project.root, filename), 'utf8'),
      '/-!\n![Figure](A.svg)\n-/\n',
      filename,
    )
  assert.equal(await fs.readFile(outside, 'utf8'), '![Figure](A.svg)\n')
})

test('a reference edited after scanning is preserved while unchanged references are updated', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.svg', '<svg/>\n')
  await write(f, 'Changed.md', '![Figure](A.svg)\n')
  await write(f, 'Unchanged.md', '![Figure](A.svg)\n')
  const spawn = childProcess.spawn
  let changed = false
  const userEdit = '![Figure](A.svg)\nKeep this newer edit.\n'
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (!changed && command === 'python3' && args[2]?.includes('renameat2')) {
      changed = true
      writeFileSync(path.join(f.project.root, 'Changed.md'), userEdit)
    }
    return spawn(command, args, options)
  })
  const response = await f.move({
    from: 'A.svg',
    to: 'B.svg',
    updateReferences: true,
  })
  assert.equal(response.status, 200)
  assert.equal(changed, true)
  const { references } = await response.json()
  assert.equal(references.updatedFiles, 1)
  assert.equal(references.updatedReferences, 1)
  assert.deepEqual(references.updatedPaths, ['Unchanged.md'])
  assert.equal(references.skippedFiles, 1)
  assert.equal(typeof references.warning, 'string')
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Changed.md')).content,
    userEdit,
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Unchanged.md')).content,
    '![Figure](B.svg)\n',
  )
})

test('reference discovery lets unrelated editor saves complete while a reference read is pending', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.svg', '<svg/>\n')
  await write(f, 'Reference.md', '![Figure](A.svg)\n')
  await write(f, 'Other.lean', '-- before\n')
  const original = await f.store.readFile(f.project.id, 'owner', 'Other.lean')
  let enterScan,
    releaseScan,
    held = false,
    released = false,
    timer
  const entered = new Promise((resolve) => {
    enterScan = resolve
  })
  const gate = new Promise((resolve) => {
    releaseScan = () => {
      released = true
      resolve()
    }
  })
  const open = fs.open
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (
      !held &&
      String(filename) === path.join(f.project.root, 'Reference.md')
    ) {
      held = true
      enterScan()
      await gate
    }
    return open(filename, ...args)
  })
  syncBuiltinESMExports()
  const moving = f.move({ from: 'A.svg', to: 'B.svg', updateReferences: true })
  let saving, response
  try {
    await Promise.race([
      entered,
      moving.then(() => {
        throw new Error('Move completed without reaching reference discovery')
      }),
    ])
    saving = f.store.writeFile(
      f.project.id,
      'owner',
      'Other.lean',
      '-- saved during reference discovery\n',
      original.hash,
    )
    await Promise.race([
      saving,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Reference discovery blocked an unrelated save')),
          2000,
        )
      }),
    ])
    assert.equal(
      released,
      false,
      'The save must finish before discovery resumes',
    )
  } finally {
    clearTimeout(timer)
    releaseScan()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    response = await moving
    await saving
  }
  assert.equal(response.status, 200)
  assert.equal((await response.json()).references.updatedFiles, 1)
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Other.lean')).content,
    '-- saved during reference discovery\n',
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Reference.md')).content,
    '![Figure](B.svg)\n',
  )
})

test('a failed reference transaction rolls back its edits and still reports the committed move', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.svg', '<svg/>\n')
  for (const filename of ['First.md', 'Second.md'])
    await write(f, filename, '![Figure](A.svg)\n')
  const rename = fs.rename
  let failed = false
  t.mock.method(fs, 'rename', async (from, to) => {
    if (String(from).includes('/staged/1')) {
      failed = true
      throw new Error('Fixture reference write failure')
    }
    return rename(from, to)
  })
  syncBuiltinESMExports()
  let response
  try {
    response = await f.move({
      from: 'A.svg',
      to: 'B.svg',
      updateReferences: true,
    })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(failed, true)
  assert.equal(response.status, 200)
  const moved = await response.json()
  assert.equal(moved.from, 'A.svg')
  assert.equal(moved.to, 'B.svg')
  assert.equal(moved.references.updatedFiles, 0)
  assert.equal(moved.references.updatedReferences, 0)
  assert.deepEqual(moved.references.updatedPaths, [])
  assert.equal(typeof moved.references.warning, 'string')
  for (const filename of ['First.md', 'Second.md'])
    assert.equal(
      (await f.store.readFile(f.project.id, 'owner', filename)).content,
      '![Figure](A.svg)\n',
    )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'B.svg')).content,
    '<svg/>\n',
  )
  await assert.rejects(fs.stat(path.join(f.project.root, 'A.svg')), {
    code: 'ENOENT',
  })
  assert.equal(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
      .get().count,
    0,
  )
  assert.equal(f.store.get(f.project.id, 'owner').status, 'ready')
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
  for (const updateReferences of [null, 0, 'true', {}, []]) {
    const response = await f.move({
      from: 'A.lean',
      to: 'B.lean',
      updateReferences,
    })
    assert.equal(response.status, 400)
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

test('moves wait for an active Git operation without changing project files', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  f.publisher.busy.add(f.project.id)
  try {
    const response = await f.move({ from: 'A.lean', to: 'B.lean' })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /Git operation/)
    assert.equal(
      (await f.store.readFile(f.project.id, 'owner', 'A.lean')).content,
      '-- A.lean\n',
    )
    await assert.rejects(fs.stat(path.join(f.project.root, 'B.lean')), {
      code: 'ENOENT',
    })
  } finally {
    f.publisher.busy.delete(f.project.id)
  }
  assert.equal((await f.move({ from: 'A.lean', to: 'B.lean' })).status, 200)
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

test('file and folder moves leave active owner and collaborator jobs running', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  await write(f, 'Folder/Child.lean')
  const states = [
    'queued',
    'starting',
    'running',
    'stopping',
    'verifying',
    'preparing',
  ]
  for (const owner of ['owner', 'editor']) {
    for (const kind of ['agent', 'check', 'tex']) {
      for (const status of states) {
        const job = f.events.create(owner, { projectId: f.project.id, kind })
        f.events.update(job.id, { status })
        const before = f.events.getMetadata(job.id)
        const folder = status === 'running' || status === 'verifying'
        const from = folder ? 'Folder' : 'A.lean'
        const to = folder ? 'MovedFolder' : 'B.lean'
        try {
          const response = await f.move({ from, to })
          assert.equal(response.status, 200, `${owner} ${kind} ${status}`)
          assert.deepEqual(f.events.getMetadata(job.id), before)
          assert.equal((await f.move({ from: to, to: from })).status, 200)
        } finally {
          f.events.update(job.id, { status: 'cancelled' })
        }
      }
    }
  }
  const cleanup = f.events.create('editor', {
    projectId: f.project.id,
    kind: 'agent',
  })
  f.events.update(cleanup.id, { status: 'failed', cleanupFailed: true })
  const before = f.events.getMetadata(cleanup.id)
  assert.equal((await f.move({ from: 'A.lean', to: 'B.lean' })).status, 200)
  assert.deepEqual(f.events.getMetadata(cleanup.id), before)
  f.events.update(cleanup.id, { cleanupFailed: false })
})

test('owner and collaborator terminals stay open while project files move', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  for (const actor of ['owner', 'editor']) {
    const ws = new WebSocket(
      `${f.url.replace('http:', 'ws:')}/websocket/terminal/${f.project.id}`,
      { headers: { Authorization: `Bearer ${f.tokens[actor]}` } },
    )
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Terminal startup timed out')),
        5000,
      )
      ws.on('message', (data, binary) => {
        if (binary && data.toString().includes('Private working copy.')) {
          clearTimeout(timer)
          resolve()
        }
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    t.after(() => ws.terminate())
    try {
      await ready
      const response = await f.move(
        { from: 'A.lean', to: 'B.lean' },
        actor === 'owner' ? 'editor' : 'owner',
      )
      assert.equal(response.status, 200, actor)
      assert.equal(ws.readyState, WebSocket.OPEN)
      assert.equal((await f.move({ from: 'B.lean', to: 'A.lean' })).status, 200)
    } finally {
      const response = await fetch(
        `${f.url}/api/projects/${f.project.id}/terminal/stop`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${f.tokens[actor]}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        },
      )
      assert.equal(response.status, 200)
    }
  }
})

test('moving source during a Lean check marks its result outdated without cancelling it', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean')
  let release, entered, options
  const running = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const run = f.runtime.run.bind(f.runtime)
  f.runtime.run = async (root, args, settings) => {
    if (args[0] === 'lake' && args[1] === 'build') {
      options = settings
      entered()
      await gate
      return { code: 0, stdout: '', stderr: '' }
    }
    return run(root, args, settings)
  }
  const manager = new JobManager({
    events: f.events,
    runtime: f.runtime,
    workspaces: f.store,
  })
  const job = manager.check('editor', f.project.id)
  const finished = manager.active.get(job.id)
  try {
    await running
    assert.equal(options.readOnlyWorkspace, true)
    assert.equal((await f.move({ from: 'A.lean', to: 'B.lean' })).status, 200)
    assert.equal(f.events.getMetadata(job.id).status, 'running')
    assert.equal(options.signal.aborted, false)
  } finally {
    release()
    await finished
  }
  const result = f.events.getMetadata(job.id)
  assert.equal(result.status, 'failed')
  assert.equal(result.result.sourceChanged, true)
  assert.match(result.error, /Project files changed during this check/)
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'B.lean')).content,
    '-- A.lean\n',
  )
})

test('terminal edits publish unrelated files after a move and reject stale source paths', async (t) => {
  const f = await fixture(t)
  await write(f, 'Figures/A.svg', '<svg><!-- original --></svg>\n')
  await write(f, 'Other.lean', '-- original\n')
  const snapshot = await f.store.terminalSnapshot(
    f.project.id,
    'editor',
    'move-terminal',
  )
  try {
    assert.equal(
      (await f.move({ from: 'Figures', to: 'MovedFigures' })).status,
      200,
    )
    await fs.writeFile(
      path.join(snapshot.root, 'Other.lean'),
      '-- private edit\n',
    )
    const published = await f.store.syncTerminal(snapshot)
    assert.equal(
      (await f.store.readFile(f.project.id, 'owner', 'Other.lean')).content,
      '-- private edit\n',
    )
    const stale = '<svg><!-- private edit --></svg>\n'
    await fs.writeFile(path.join(snapshot.root, 'Figures/A.svg'), stale)
    await assert.rejects(f.store.syncTerminal(snapshot, published), {
      status: 409,
    })
    await assert.rejects(fs.stat(path.join(f.project.root, 'Figures')), {
      code: 'ENOENT',
    })
    assert.equal(
      (await f.store.readFile(f.project.id, 'owner', 'MovedFigures/A.svg'))
        .content,
      '<svg><!-- original --></svg>\n',
    )
    assert.equal(
      await fs.readFile(path.join(snapshot.root, 'Figures/A.svg'), 'utf8'),
      stale,
    )
  } finally {
    await f.store.cleanupTerminalSnapshot(snapshot, { finalize: true })
  }
})

test('agent updates survive unrelated moves and cannot update or undo moved source paths', async (t) => {
  const f = await fixture(t)
  await write(f, 'A.lean', '-- A\n')
  await write(f, 'Other.lean', '-- original\n')
  const original = await f.store.readFile(f.project.id, 'owner', 'Other.lean')
  const snapshot = await f.store.snapshot(f.project.id, 'editor', 'move-agent')
  assert.equal((await f.move({ from: 'A.lean', to: 'B.lean' })).status, 200)
  const change = {
    path: 'Other.lean',
    before: original.content,
    beforeHash: original.hash,
    after: '-- agent edit\n',
  }
  const published = await f.store.syncLive(snapshot, [change])
  assert.equal(
    (await f.move({ from: 'Other.lean', to: 'Moved.lean' })).status,
    200,
  )
  await assert.rejects(
    f.store.syncLive(
      snapshot,
      [{ ...change, after: '-- later edit\n' }],
      published,
    ),
    { status: 409 },
  )
  await assert.rejects(f.store.undoLive(snapshot, published), { status: 409 })
  await assert.rejects(
    f.store.applyChanges(f.project.id, 'editor', [change], { snapshot }),
    { status: 409 },
  )
  await assert.rejects(fs.stat(path.join(f.project.root, 'Other.lean')), {
    code: 'ENOENT',
  })
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Moved.lean')).content,
    change.after,
  )
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
