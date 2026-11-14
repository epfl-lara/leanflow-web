import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { renameSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  captureTerminalIdentities,
  matchTerminalMoves,
  prepareTerminalReferenceUpdates,
} from '../terminal-reference-updates.mjs'
import { applyReferenceUpdates } from '../workspace-reference-scan.mjs'
import { createReferenceRewriter } from '../workspace-references.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

const hash = (content) => createHash('sha256').update(content).digest('hex')
const files = (contents) =>
  [...contents].map(([path, content]) => ({
    path,
    size: Buffer.byteLength(content),
  }))
const read = (contents) => async (filename) => {
  assert(contents.has(filename), `Missing fixture file ${filename}`)
  const content = contents.get(filename)
  return { content, hash: hash(content) }
}
const rename = (from, to, content) => [
  { path: from, before: content, after: null, beforeHash: hash(content) },
  { path: to, before: null, after: content, beforeHash: null },
]

async function workspaceFixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-terminal-move-sync-'),
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
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  const snapshots = []
  t.after(async () => {
    for (const snapshot of snapshots)
      await store.cleanupTerminalSnapshot(snapshot, { finalize: true })
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(project.id)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const from = 'Problems/Problem1_16_figure.svg'
  const to = 'Problems/figures/Problem1_16_figure.svg'
  const theorem = 'Problems/Problem1_16.lean'
  const svg = '<svg><!-- figure 1.16 --></svg>\n'
  const original =
    '-- [Diagram](Problem1_16_figure.svg)\nexample : True := by trivial\n'
  const updated = original.replace(
    '(Problem1_16_figure.svg)',
    '(figures/Problem1_16_figure.svg)',
  )
  for (const [filename, content] of [
    [from, svg],
    [theorem, original],
  ])
    await store.writeFile(project.id, 'alice', filename, content, null)
  const terminal = async (actor, runId) => {
    const snapshot = await store.terminalSnapshot(project.id, actor, runId)
    snapshots.push(snapshot)
    return snapshot
  }
  return { store, project, from, to, theorem, svg, original, updated, terminal }
}

test('terminal publication rewrites the actual theorem link and keeps both private copies and later polls current', async (t) => {
  const f = await workspaceFixture(t)
  const first = await f.terminal('alice', 'terminal-reference-first')
  const second = await f.terminal('bob', 'terminal-reference-second')
  await fs.mkdir(path.dirname(path.join(first.root, f.to)))
  await fs.rename(path.join(first.root, f.from), path.join(first.root, f.to))
  const notices = []
  let firstChanges = await f.store.syncTerminal(first, [], {
    onReferenceWarning: (notice) => notices.push(notice),
  })
  assert(
    Array.isArray(firstChanges),
    'TerminalSourceMirror still receives cumulative changes as an array.',
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.theorem)).content,
    f.updated,
  )
  assert.equal(
    await fs.readFile(path.join(first.root, f.theorem), 'utf8'),
    f.updated,
  )
  let secondChanges = await f.store.syncTerminal(second)
  assert.equal(
    await fs.readFile(path.join(second.root, f.theorem), 'utf8'),
    f.updated,
  )
  assert.equal(await fs.readFile(path.join(second.root, f.to), 'utf8'), f.svg)
  await assert.rejects(fs.stat(path.join(second.root, f.from)), {
    code: 'ENOENT',
  })
  firstChanges = await f.store.syncTerminal(first, firstChanges)
  secondChanges = await f.store.syncTerminal(second, secondChanges)
  assert.equal(
    (await f.store.readFile(f.project.id, 'alice', f.theorem)).content,
    f.updated,
  )
  assert.equal(notices.some(Boolean), false)
  const later = f.updated + '-- typed in terminal after the move\n'
  await fs.writeFile(path.join(first.root, f.theorem), later)
  await f.store.syncTerminal(first, firstChanges)
  await f.store.syncTerminal(second, secondChanges)
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.theorem)).content,
    later,
  )
  assert.equal(
    await fs.readFile(path.join(second.root, f.theorem), 'utf8'),
    later,
  )
})

test('a proven terminal move can return a web-moved figure to its original path', async (t) => {
  const f = await workspaceFixture(t)
  const snapshot = await f.terminal('alice', 'terminal-reference-return')
  await f.store.createFolder(f.project.id, 'bob', { path: 'Problems/figures' })
  await f.store.moveEntry(f.project.id, 'bob', {
    from: f.from,
    to: f.to,
    updateReferences: true,
  })
  const pulled = await f.store.syncTerminal(snapshot)
  assert.equal(
    await fs.readFile(path.join(snapshot.root, f.theorem), 'utf8'),
    f.updated,
  )
  await fs.rename(
    path.join(snapshot.root, f.to),
    path.join(snapshot.root, f.from),
  )
  const moved = await f.store.syncTerminal(snapshot, pulled)
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.theorem)).content,
    f.original,
  )
  assert.equal(
    await fs.readFile(path.join(snapshot.root, f.theorem), 'utf8'),
    f.original,
  )
  await f.store.syncTerminal(snapshot, moved)
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.from)).content,
    f.svg,
  )
})

for (const operation of ['delete', 'file move', 'folder move'])
  test(`a terminal can recreate paths after its own ${operation} without pausing its peer`, async (t) => {
    const f = await workspaceFixture(t)
    await f.store.writeFile(
      f.project.id,
      'alice',
      'Old/A.lean',
      '-- original\n',
      null,
    )
    const first = await f.terminal(
      'alice',
      `terminal-recreate-${operation.replace(' ', '-')}`,
    )
    const second = await f.terminal(
      'bob',
      `peer-recreate-${operation.replace(' ', '-')}`,
    )
    let restoredPath = f.from
    if (operation === 'delete') await fs.unlink(path.join(first.root, f.from))
    else if (operation === 'file move') {
      await fs.mkdir(path.dirname(path.join(first.root, f.to)))
      await fs.rename(
        path.join(first.root, f.from),
        path.join(first.root, f.to),
      )
    } else {
      await fs.rename(
        path.join(first.root, 'Old'),
        path.join(first.root, 'New'),
      )
      restoredPath = 'Old/Created.lean'
    }
    const published = await f.store.syncTerminal(first)
    const peerChanges = await f.store.syncTerminal(second)
    const restored =
      operation === 'folder move'
        ? '-- recreated in the old folder\n'
        : '<svg><!-- recreated --></svg>\n'
    await fs.mkdir(path.dirname(path.join(first.root, restoredPath)), {
      recursive: true,
    })
    await fs.writeFile(path.join(first.root, restoredPath), restored)
    const next = await f.store.syncTerminal(first, published)
    await f.store.syncTerminal(second, peerChanges)
    await f.store.syncTerminal(first, next)
    assert.equal(
      (await f.store.readFile(f.project.id, 'bob', restoredPath)).content,
      restored,
    )
    assert.equal(
      await fs.readFile(path.join(second.root, restoredPath), 'utf8'),
      restored,
    )
  })

test('a rename made during another publication is still proved on the following poll', async (t) => {
  const f = await workspaceFixture(t)
  const snapshot = await f.terminal(
    'alice',
    'terminal-reference-delayed-rename',
  )
  await fs.mkdir(path.dirname(path.join(snapshot.root, f.to)))
  await fs.writeFile(
    path.join(snapshot.root, 'Other.lean'),
    '-- publish first\n',
  )
  let renamed = false
  f.store.subscribeChanges((event) => {
    if (renamed || !event.paths.includes('Other.lean')) return
    renameSync(path.join(snapshot.root, f.from), path.join(snapshot.root, f.to))
    renamed = true
  })
  const first = await f.store.syncTerminal(snapshot)
  assert.equal(renamed, true)
  const warnings = []
  await f.store.syncTerminal(snapshot, first, {
    onReferenceWarning: (warning) => warnings.push(warning),
  })
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.theorem)).content,
    f.updated,
  )
  assert.equal(warnings.some(Boolean), false)
})

test('terminal move reference edits preserve text changed in the same poll and include new shared documents', async (t) => {
  const f = await workspaceFixture(t)
  const snapshot = await f.terminal('alice', 'terminal-reference-local-edit')
  const local = '-- terminal note must survive\n' + f.original
  await fs.writeFile(path.join(snapshot.root, f.theorem), local)
  await f.store.writeFile(
    f.project.id,
    'bob',
    'Added.md',
    '[Diagram](Problems/Problem1_16_figure.svg)\n',
    null,
  )
  await fs.mkdir(path.dirname(path.join(snapshot.root, f.to)))
  await fs.rename(
    path.join(snapshot.root, f.from),
    path.join(snapshot.root, f.to),
  )
  const changes = await f.store.syncTerminal(snapshot)
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.theorem)).content,
    '-- terminal note must survive\n' + f.updated,
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', 'Added.md')).content,
    '[Diagram](Problems/figures/Problem1_16_figure.svg)\n',
  )
  assert.equal(
    await fs.readFile(path.join(snapshot.root, f.theorem), 'utf8'),
    '-- terminal note must survive\n' + f.updated,
  )
  await f.store.syncTerminal(snapshot, changes)
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.theorem)).content,
    '-- terminal note must survive\n' + f.updated,
  )
})

test('terminal delete and same-content create publishes bytes without guessing reference replacements', async (t) => {
  const f = await workspaceFixture(t)
  const snapshot = await f.terminal('alice', 'terminal-reference-not-a-rename')
  await fs.mkdir(path.dirname(path.join(snapshot.root, f.to)))
  await fs.copyFile(
    path.join(snapshot.root, f.from),
    path.join(snapshot.root, f.to),
  )
  await fs.unlink(path.join(snapshot.root, f.from))
  const events = []
  f.store.subscribeChanges((event) => events.push(event))
  const warnings = []
  const changes = await f.store.syncTerminal(snapshot, [], {
    onReferenceWarning: (warning) => warnings.push(warning),
  })
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.to)).content,
    f.svg,
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'bob', f.theorem)).content,
    f.original,
  )
  assert(
    events.every((event) => !event.moves?.length),
    'A delete and create must not redirect another editor through a guessed move event.',
  )
  assert(
    warnings.some(Boolean),
    'A plausible content match without rename identity must report that links need review.',
  )
  await f.store.syncTerminal(snapshot, changes)
  assert.equal(
    (await f.store.readFile(f.project.id, 'alice', f.theorem)).content,
    f.original,
  )
})

async function applyPlan(plan, contents) {
  return applyReferenceUpdates(plan, {
    readFile: read(contents),
    apply: async (updates) => {
      for (const update of updates)
        assert.equal(hash(contents.get(update.path)), update.beforeHash)
      for (const update of updates) contents.set(update.path, update.after)
    },
  })
}

test('a real terminal figure rename proves identity and updates its theorem comment link', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-terminal-refs-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const from = 'Problems/Problem1_16_figure.svg'
  const to = 'Problems/figures/Problem1_16_figure.svg'
  const theorem = 'Problems/Problem1_16.lean'
  const svg = '<svg><!-- figure 1.16 --></svg>\n'
  const comment =
    '-- [Diagram](Problem1_16_figure.svg)\nexample : True := by trivial\n'
  const contents = new Map([
    [from, svg],
    [theorem, comment],
  ])
  for (const [filename, content] of contents) {
    await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true })
    await fs.writeFile(path.join(root, filename), content)
  }
  const identity = (filename) =>
    fs.lstat(path.join(root, filename), { bigint: true })
  const previous = await captureTerminalIdentities(files(contents), identity)
  await fs.mkdir(path.dirname(path.join(root, to)))
  await fs.rename(path.join(root, from), path.join(root, to))
  const current = await captureTerminalIdentities([to, theorem], identity)
  const transition = rename(from, to, svg)
  const moves = matchTerminalMoves(transition, previous, current)
  assert.deepEqual(moves, [{ from, to }])
  const plan = await prepareTerminalReferenceUpdates({
    transition,
    moves,
    files: files(contents),
    readFile: read(contents),
  })
  contents.delete(from)
  contents.set(to, svg)
  const result = await applyPlan(plan, contents)
  assert.equal(result.updatedFiles, 1)
  assert.equal(result.updatedReferences, 1)
  assert.equal(
    contents.get(theorem),
    '-- [Diagram](figures/Problem1_16_figure.svg)\nexample : True := by trivial\n',
  )
  assert.equal(contents.has(from), false)
  assert.equal(contents.get(to), svg)
})

test('delete and create pairs cannot authorize reference updates without a matching inode generation', () => {
  const transition = rename('Old.svg', 'New.svg', '<svg/>')
  assert.deepEqual(
    matchTerminalMoves(
      transition,
      new Map([['Old.svg', '1:2:3']]),
      new Map([['New.svg', '1:2:4']]),
    ),
    [],
  )
  assert.deepEqual(
    matchTerminalMoves(
      transition,
      new Map([['Old.svg', '1:2:3']]),
      new Map([['New.svg', '1:4:3']]),
    ),
    [],
  )
  assert.deepEqual(
    matchTerminalMoves(transition, undefined, new Map([['New.svg', '1:2:3']])),
    [],
  )
})

test('hard-linked identities and duplicate-content moves stay ambiguous', () => {
  const transition = rename('Old.svg', 'New.svg', '<svg/>')
  assert.deepEqual(
    matchTerminalMoves(
      transition,
      new Map([
        ['Old.svg', '1:2:3'],
        ['Also.svg', '1:2:3'],
      ]),
      new Map([
        ['New.svg', '1:2:3'],
        ['Also.svg', '1:2:3'],
      ]),
    ),
    [],
  )
  assert.deepEqual(
    matchTerminalMoves(
      [...transition, ...rename('Old2.svg', 'New2.svg', '<svg/>')],
      new Map([
        ['Old.svg', '1:2:3'],
        ['Old2.svg', '1:4:5'],
      ]),
      new Map([
        ['New.svg', '1:2:3'],
        ['New2.svg', '1:4:5'],
      ]),
    ),
    [],
  )
})

test('identity capture skips missing, symbolic and generation-less metadata', async () => {
  const identities = await captureTerminalIdentities(
    ['missing', 'link', 'unknown', 'good'],
    async (filename) => {
      if (filename === 'missing')
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return {
        dev: 1n,
        ino: 2n,
        birthtimeNs: filename === 'unknown' ? 0n : 3n,
        isFile: () => true,
        isSymbolicLink: () => filename === 'link',
      }
    },
  )
  assert.deepEqual([...identities], [['good', '1:2:3']])
})

test('reference plans preserve same-poll terminal edits and include new terminal and collaborator documents', async () => {
  const from = 'Problems/Figure.svg',
    to = 'Problems/figures/Figure.svg'
  const svg = '<svg/>'
  const original = '-- [Diagram](Figure.svg)\n'
  const edited = '-- terminal note kept\n' + original
  const created = '[Diagram](Problems/Figure.svg)\n'
  const contents = new Map([
    [from, svg],
    ['Problems/Main.lean', original],
    ['Collaborator.md', '[Added in another browser](Problems/Figure.svg)\n'],
  ])
  const transition = [
    ...rename(from, to, svg),
    {
      path: 'Problems/Main.lean',
      before: original,
      after: edited,
      beforeHash: hash(original),
    },
    { path: 'Created.md', before: null, after: created, beforeHash: null },
  ]
  const plan = await prepareTerminalReferenceUpdates({
    transition,
    moves: [{ from, to }],
    files: files(contents),
    readFile: read(contents),
  })
  assert.equal(
    plan.updates.find((update) => update.path === 'Problems/Main.lean')
      .beforeHash,
    hash(edited),
  )
  assert.equal(
    plan.updates.find((update) => update.path === 'Created.md').beforeHash,
    hash(created),
  )
  for (const change of transition)
    if (change.after === null) contents.delete(change.path)
    else contents.set(change.path, change.after)
  const result = await applyPlan(plan, contents)
  assert.equal(result.updatedFiles, 3)
  assert.equal(result.updatedReferences, 3)
  assert.equal(
    contents.get('Problems/Main.lean'),
    '-- terminal note kept\n-- [Diagram](figures/Figure.svg)\n',
  )
  assert.equal(
    contents.get('Created.md'),
    '[Diagram](Problems/figures/Figure.svg)\n',
  )
  assert.equal(
    contents.get('Collaborator.md'),
    '[Added in another browser](Problems/figures/Figure.svg)\n',
  )
})

test('a reference changed after scanning is preserved while other reference edits can commit', async () => {
  const from = 'Figure.svg',
    to = 'figures/Figure.svg',
    svg = '<svg/>'
  const original = '[Diagram](Figure.svg)\n'
  const contents = new Map([
    [from, svg],
    ['First.md', original],
    ['Second.md', original],
  ])
  const plan = await prepareTerminalReferenceUpdates({
    transition: rename(from, to, svg),
    moves: [{ from, to }],
    files: files(contents),
    readFile: read(contents),
  })
  contents.delete(from)
  contents.set(to, svg)
  contents.set('First.md', 'New browser text must survive.\n' + original)
  const result = await applyPlan(plan, contents)
  assert.equal(result.updatedFiles, 1)
  assert.equal(result.skippedFiles, 1)
  assert.match(result.warning, /Some files changed/)
  assert.equal(
    contents.get('First.md'),
    'New browser text must survive.\n' + original,
  )
  assert.equal(contents.get('Second.md'), '[Diagram](figures/Figure.svg)\n')
})

test('a folder move updates imports and rebases moved documents once against the complete relocation', async () => {
  const contents = new Map([
    ['Old/README.md', '[Internal](plot.svg) [Shared](../shared/Other.md)\n'],
    ['Old/plot.svg', '<svg/>'],
    ['Old/Proof.lean', '-- [Plot](plot.svg)\nexample : True := by trivial\n'],
    ['shared/Other.md', 'External document.\n'],
    ['Main.lean', 'import Old.Proof\n'],
    ['README.md', '[Notes](Old/README.md)\n'],
  ])
  const moves = ['Old/README.md', 'Old/plot.svg', 'Old/Proof.lean'].map(
    (from) => ({ from, to: 'Archive/New/' + from.slice(4) }),
  )
  const transition = moves.flatMap(({ from, to }) =>
    rename(from, to, contents.get(from)),
  )
  const plan = await prepareTerminalReferenceUpdates({
    transition,
    moves,
    files: files(contents),
    readFile: read(contents),
  })
  for (const change of transition)
    if (change.after === null) contents.delete(change.path)
    else contents.set(change.path, change.after)
  const result = await applyPlan(plan, contents)
  assert.equal(result.updatedFiles, 3)
  assert.equal(result.updatedReferences, 3)
  assert.equal(
    contents.get('Archive/New/README.md'),
    '[Internal](plot.svg) [Shared](../../shared/Other.md)\n',
  )
  assert.equal(
    contents.get('Archive/New/Proof.lean'),
    '-- [Plot](plot.svg)\nexample : True := by trivial\n',
  )
  assert.equal(contents.get('Main.lean'), 'import Archive.New.Proof\n')
  assert.equal(contents.get('README.md'), '[Notes](Archive/New/README.md)\n')
})

test('simultaneous relocation does not rewrite an already mapped path a second time', () => {
  const rewrite = createReferenceRewriter({
    files: ['One.svg', 'Two.svg'],
    moves: [
      { from: 'One.svg', to: 'Two.svg' },
      { from: 'Two.svg', to: 'Three.svg' },
    ],
  })
  assert.deepEqual(rewrite('[One](One.svg) [Two](Two.svg)', 'README.md'), {
    content: '[One](Two.svg) [Two](Three.svg)',
    count: 2,
  })
})

test('protected files stay unread and an expired discovery reports incomplete updates', async () => {
  const from = 'Figure.svg',
    to = 'figures/Figure.svg',
    svg = '<svg/>'
  const contents = new Map([
    [from, svg],
    ['Private/Notes.md', '[Diagram](Figure.svg)'],
    ['README.md', '[Diagram](Figure.svg)'],
  ])
  const reads = []
  const plan = await prepareTerminalReferenceUpdates({
    transition: rename(from, to, svg),
    moves: [{ from, to }],
    files: files(contents),
    readFile: async (filename) => {
      reads.push(filename)
      return read(contents)(filename)
    },
    signal: AbortSignal.abort(),
    isProtected: (filename) => filename.startsWith('Private/'),
  })
  assert.deepEqual(reads, [])
  assert.equal(plan.skippedFiles, 1)
  assert.deepEqual(plan.updates, [])
})
