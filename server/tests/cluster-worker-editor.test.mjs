import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { LspFrames } from '../rpc.mjs'
import { WorkerEditor, editorSource } from '../cluster/worker-editor.mjs'
import { sha256 } from '../cluster/state.mjs'

const helper = 'Demo/Helper.lean'
const initial = 'def x := 1\n'
const source = {
  kind: 'source',
  totalBytes: 100,
  entries: [
    'lean-toolchain',
    'lakefile.lean',
    'lake-manifest.json',
    helper,
    'Demo.lean',
  ].map((name) => ({
    type: 'file',
    path: name,
    hash: sha256(name === helper ? initial : ''),
  })),
}

test('repository editors require a complete prepared Lake snapshot and support projects without Main.lean', () => {
  assert.equal(editorSource(source, 'repository'), true)
  assert.equal(editorSource(source), false)
  const without = (name) => ({
    ...source,
    entries: source.entries.filter((entry) => entry.path !== name),
  })
  for (const name of ['lean-toolchain', 'lakefile.lean', 'lake-manifest.json'])
    assert.equal(editorSource(without(name), 'repository'), false)
  for (const extra of [
    { type: 'symlink', path: 'Alias.lean', target: helper },
    { type: 'file', path: '.lake/build/Old.olean' },
  ])
    assert.equal(
      editorSource(
        { ...source, entries: [...source.entries, extra] },
        'repository',
      ),
      false,
    )
})

test('a repository session mirrors only captured modules and notifies Lean after a complete verified save', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lf-worker-editor-')),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'Demo'))
  await fs.writeFile(path.join(root, helper), initial)
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    workerStopped: Promise.resolve(),
    cleanupWorker: async () => {},
    kill: () => {},
  })
  const notices = []
  const reader = new LspFrames((value) => notices.push(value))
  child.stdin.on('data', (chunk) => reader.push(chunk))
  const session = new WorkerEditor({
    id: 'replica',
    peer: { request: async () => ({}) },
    abort: new AbortController(),
  })
  const running = session.run({ spawn: () => child }, root, {}, source)
  t.after(async () => {
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0)
    await running
  })
  const bytes = Buffer.from('def x := 2\n')
  const chunk = (overrides = {}) => ({
    revision: 1,
    path: helper,
    size: bytes.length,
    hash: sha256(bytes),
    offset: 0,
    data: bytes.toString('base64'),
    ...overrides,
  })
  for (const path of [
    undefined,
    'BrandNew.lean',
    'lakefile.lean',
    '.lake/build/Old.lean',
  ])
    assert.throws(() => session.sync(chunk({ path })), {
      code: 'editor_protocol',
    })
  assert.deepEqual(
    session.sync(chunk({ data: bytes.subarray(0, 4).toString('base64') })),
    { offset: 4 },
  )
  assert.equal(await fs.readFile(path.join(root, helper), 'utf8'), initial)
  assert.throws(() => session.sync(chunk({ path: 'Demo.lean', offset: 4 })), {
    code: 'editor_protocol',
  })
  await session.sync(
    chunk({ offset: 4, data: bytes.subarray(4).toString('base64') }),
  )
  assert.deepEqual(await fs.readFile(path.join(root, helper)), bytes)
  assert.deepEqual(
    notices.map((notice) => [notice.method, notice.params]),
    [
      [
        'workspace/didChangeWatchedFiles',
        { changes: [{ uri: 'file:///workspace/Demo/Helper.lean', type: 2 }] },
      ],
    ],
  )
  assert.throws(() => session.sync(chunk()), { code: 'editor_protocol' })
  await session.sync(chunk({ revision: 2 }))
  assert.equal(
    notices.length,
    1,
    'An unchanged save preserves imported module timestamps',
  )
})
