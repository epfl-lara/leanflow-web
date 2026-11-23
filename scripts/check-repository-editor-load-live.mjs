// Opt-in real API, collaboration and Lean protocol test. All projects are temporary.
// For 22 live editors plus one waiting account, pass --queue-probe to account
// preparation and each topology. The local version holds two editors plus one
// waiter and requires an isolated server configured with two editor slots.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
  compileLoadFixture,
  loadTestSetting,
} from './lib/compile-load-fixture.mjs'
import { connectProjectDocumentPeer } from './lib/project-document-peer.mjs'
import {
  RepositoryEditor,
  repositoryEditorScenario,
  waitForEvidence,
} from './lib/repository-editor-session.mjs'
import {
  repositoryPlacements,
  summarizePlacements,
} from './lib/repository-editor-placement.mjs'

const topology = process.argv[2]
assert(['distinct', 'shared'].includes(topology), 'Choose distinct or shared')
const { localProbe, queueProbe, users, accounts } = repositoryEditorScenario(
  process.argv.slice(3),
)
const { state, directory, origin } = await compileLoadFixture({
  users: accounts,
  requireProjects: false,
})
if (localProbe)
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
const requiredNodes = localProbe
  ? []
  : loadTestSetting('STUDIO_LOAD_WORKERS')
      .split(',')
      .map((s) => s.trim())
assert(requiredNodes.every((n) => /^[a-zA-Z0-9._-]+$/.test(n)))
const dataDir = loadTestSetting('STUDIO_LOAD_DATA_DIR')
const toolchain = loadTestSetting('STUDIO_LOAD_TOOLCHAIN')
assert(/^leanprover\/lean4:v[0-9.]+(?:-rc[0-9]+)?$/.test(toolchain))
const preset = process.env.STUDIO_LOAD_PRESET || 'lean'
assert(['lean', 'mathlib'].includes(preset))
const nonce = randomUUID()
const started = performance.now()
const projects = [],
  sockets = new Set(),
  editors = [],
  participants = []
let interrupted = false,
  cleaning = false
function interrupt() {
  interrupted = true
  for (const ws of [...sockets, ...editors.map((editor) => editor.socket)])
    ws.terminate()
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const report = {
  topology,
  users,
  preset,
  toolchain,
  localProbe,
  queueProbe,
  passed: false,
  importRefreshes: 0,
}
const resultFile = path.join(
  directory,
  'repository-editors-' + topology + '-' + nonce + '.json',
)
const marker = 'repository-editor-' + nonce
const common = 'Main/RepoLoad.lean'
const initial = 'namespace RepoLoad\ndef initial : Nat := 1\nend RepoLoad\n'
const scope = (id) => '/api/projects/' + id
const file = (id, name) => scope(id) + '/file?path=' + encodeURIComponent(name)
const target = (i) => 'Main/Proof' + String(i + 1).padStart(2, '0') + '.lean'
const witness = (i) => 'witness' + String(i + 1).padStart(2, '0')
const value = (i) => 7300 + i
const source = (i, final = false) =>
  (preset === 'mathlib' ? 'import Mathlib\n' : '') +
  'import Main.RepoLoad\n\n' +
  (final ? '#eval RepoLoad.' + witness(i) + '\n' : '#eval RepoLoad.initial\n') +
  'example (n : Nat) : n = n := by\n  rfl\n'

async function api(
  account,
  endpoint,
  body,
  method = body === undefined ? 'GET' : 'POST',
) {
  for (let retry = 0; ; retry++) {
    if (interrupted && !cleaning) throw new Error('Load test interrupted')
    const res = await fetch(origin + endpoint, {
      method,
      headers: {
        Authorization: 'Bearer ' + account.token,
        Origin: origin,
        'X-LeanFlow-User': account.id,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(35_000),
    })
    const response = await res.json()
    if (
      res.status === 429 &&
      (method === 'PUT' || method === 'GET') &&
      retry < 6
    ) {
      await delay(1000 + retry * 200)
      continue
    }
    assert(
      res.ok,
      method +
        ' ' +
        endpoint.split('?')[0] +
        ' failed: ' +
        res.status +
        ' ' +
        (response.error || ''),
    )
    return response
  }
}

async function parallel(items, callback) {
  const result = await Promise.allSettled(items.map(callback))
  const rejection = result.find((r) => r.status === 'rejected')
  if (rejection) throw rejection.reason
}

function requireIdle(session) {
  assert(session.runtime.ready, 'Lean workers must be ready for the rehearsal')
  assert.equal(
    session.runtime.active + session.runtime.queued,
    0,
    'A worker is busy',
  )
  const { active, queued } = session.capacity.editorAdmission
  assert.equal(
    active + queued,
    0,
    'A live or waiting editor still needs the service',
  )
}

async function prepare(owner, number) {
  const name = state.runTag + ' repo ' + nonce.slice(0, 8) + ' ' + number
  const project = await api(owner, '/api/projects', {
    name,
    preset,
    ...(preset === 'lean' ? { libraries: [] } : {}),
    toolchain,
    autoRepair: false,
  })
  assert.match(project.id, /^[a-f0-9-]{36}$/)
  projects.push({ id: project.id, name, owner })
  assert.equal(project.name, name)
  await waitForEvidence(async () => {
    const p = await api(owner, scope(project.id))
    assert(!['error', 'needs-setup'].includes(p.status), 'Fixture setup failed')
    return p.status === 'ready'
  }, 'pinned repository preparation')
  assert.equal(
    (await api(owner, file(project.id, 'lean-toolchain'))).content.trim(),
    toolchain,
  )
  if (!(await api(owner, scope(project.id) + '/folders')).includes('Main'))
    await api(owner, scope(project.id) + '/folders', { path: 'Main' })
  await api(
    owner,
    file(project.id, common),
    { content: initial, expectedHash: null },
    'PUT',
  )
  return project
}

function proves(diagnostics, expected) {
  return (
    !diagnostics.some((d) => d.severity === 1) &&
    diagnostics.some(
      (d) => d.severity === 3 && d.message.trim() === String(expected),
    )
  )
}

function openEditor(p) {
  const editor = new RepositoryEditor(origin, p.account, p.project, target(p.i))
  editors.push(editor)
  p.editor = editor
  return editor
}

async function placementBarrier(label, active) {
  for (const { editor: e } of active) {
    assert(
      !e.error && e.socket.readyState === WebSocket.OPEN,
      'Every editor must remain connected',
    )
  }
  const placed = await repositoryPlacements(dataDir, participants, !localProbe)
  assert.equal(placed.local.length + placed.remote.length, active.length)
  report[label] = summarizePlacements(placed, active, requiredNodes)
  if (queueProbe && !localProbe) {
    assert.equal(placed.local.length, 4, 'Expected four coordinator editors')
    assert.equal(placed.remote.length, 18, 'Expected eighteen remote editors')
  }
}

async function verifyPromotion(active, waiter) {
  const editor = openEditor(waiter)
  const admission = editor.start()
  admission.catch(() => {}) // The test may fail while initialization is pending.
  await editor.wait(
    () => editor.queue?.state === 'waiting',
    'queue notification',
  )
  assert(!editor.initialized)
  const position = editor.queue.position
  assert.equal(position, 1)
  const peer = await connectProjectDocumentPeer(
    {
      origin,
      projectId: waiter.project.id,
      token: waiter.account.token,
      sockets,
      timeoutMs: 30000,
    },
    { name: editor.file },
  )
  const queuedValue = 96822
  const addition = '\n#eval ' + queuedValue + '\n'
  const edit = peer.edit((text) => text.insert(text.length, addition))
  assert.equal((await peer.ack(edit)).type, 'document')
  const saved = (
    await api(waiter.account, file(waiter.project.id, editor.file))
  ).content
  assert.equal(saved, source(waiter.i) + addition)
  await placementBarrier('placementsWhileWaiting', active)
  assert(!editor.initialized && editor.queue.state === 'waiting')
  const releasedAt = performance.now()
  active[0].editor.socket.close(1000, 'Fixture editor finished')
  await admission
  editor.open(saved)
  const diagnostics = await editor.checked()
  assert(
    proves(diagnostics, queuedValue),
    'The promoted session must elaborate the queued save',
  )
  await editor.goal(saved)
  await placementBarrier('placementsAfterPromotion', [
    ...active.slice(1),
    waiter,
  ])
  report.overflow = {
    position,
    savedWhileWaiting: true,
    sameSocketPromoted: true,
    checkedQueuedSave: true,
    promotedAndVerifiedMs: Math.round(performance.now() - releasedAt),
  }
}

try {
  for (const [i, account] of state.accounts.entries()) {
    const session = await api(account, '/api/session')
    assert.equal(session.user.id, account.id)
    assert.equal(session.user.name, account.name)
    assert.equal(session.user.role, 'user')
    assert.equal(session.lemex.configured, false)
    if (queueProbe && i === 0) requireIdle(session)
    report.capacity ||= {
      editors: session.capacity.editors,
      perProject: session.capacity.editorsPerProject,
      perUser: session.capacity.editorsPerUser,
    }
    if (!localProbe) {
      assert(
        report.capacity.editors >= users,
        'Insufficient live editor capacity for this test',
      )
      if (topology === 'shared')
        assert(
          report.capacity.perProject >= accounts,
          'Project-specific admission would constrain the shared-project test',
        )
    }
    const project =
      topology === 'shared' && i
        ? participants[0].project
        : await prepare(account, i)
    const owner = topology === 'shared' ? state.accounts[0] : account
    if (topology === 'shared' && i)
      await api(
        owner,
        scope(project.id) + '/sharing/members/' + account.id,
        { role: 'editor' },
        'PUT',
      )
    const writer = state.accounts[(i + 1) % accounts]
    if (topology === 'distinct')
      await api(
        owner,
        scope(project.id) + '/sharing/members/' + writer.id,
        { role: 'editor' },
        'PUT',
      )
    await api(
      owner,
      file(project.id, target(i)),
      { content: source(i), expectedHash: null },
      'PUT',
    )
    participants.push({ account, writer, project, i })
  }
  assert.equal(
    new Set(participants.map((p) => p.project.id)).size,
    topology === 'shared' ? 1 : accounts,
  )
  for (const p of participants) {
    const live = await api(p.account, scope(p.project.id))
    assert.equal(live.kind ?? 'project', 'project')
    assert.equal(live.name, p.project.name)
    assert.equal(
      (await api(p.writer, scope(p.project.id))).accessRole,
      topology === 'shared' && p.writer.id === state.accounts[0].id
        ? 'admin'
        : 'editor',
    )
  }
  const active = participants.slice(0, users)
  if (queueProbe) requireIdle(await api(active[0].account, '/api/session'))
  for (const p of active) openEditor(p)
  await parallel(active, async ({ editor, i }) => {
    await editor.initialize(source(i))
    const initialDiagnostics = await editor.checked()
    assert(
      proves(initialDiagnostics, 1),
      'Initial repository import: ' +
        JSON.stringify(initialDiagnostics.map((d) => d.message).slice(0, 4)),
    )
    await editor.goal(source(i))
  })
  await placementBarrier('initialPlacements', active)
  report.allActiveMs = Math.round(performance.now() - started)
  console.log(
    users +
      ' concurrent repository editors returned real diagnostics and goals (' +
      topology +
      ')',
  )

  // The writer is always a different account from the consumer. Shared collaborators
  // append distinct declarations using Yjs; each consumer has its own proof file.
  await parallel(active, async (p) => {
    p.peer = await connectProjectDocumentPeer(
      {
        origin,
        projectId: p.project.id,
        token: p.writer.token,
        sockets,
        timeoutMs: 30000,
      },
      { name: common },
    )
  })
  await parallel(active, async ({ peer, i }) => {
    const id = peer.edit((text) =>
      text.insert(
        text.length,
        '\ndef RepoLoad.' + witness(i) + ' : Nat := ' + value(i) + '\n',
      ),
    )
    const ack = await peer.ack(id)
    assert.equal(ack.type, 'document', ack.message)
  })
  await parallel(active, async ({ project, account, editor, i }) => {
    const helper = (await api(account, file(project.id, common))).content
    assert(
      helper.includes('def RepoLoad.' + witness(i) + ' : Nat := ' + value(i)),
    )
    editor.change(source(i) + '\nexample : Nat := "' + marker + '"\n')
    assert(
      (await editor.checked()).some(
        (d) =>
          d.severity === 1 &&
          /type mismatch/i.test(d.message) &&
          d.message.includes(marker),
      ),
      'Expected the deliberate type mismatch',
    )
    const corrected = source(i, true)
    const before = await api(account, file(project.id, editor.file))
    await api(
      account,
      file(project.id, editor.file),
      { content: corrected, expectedHash: before.hash },
      'PUT',
    )
    editor.change(corrected)
    let ds = await editor.checked()
    if (!proves(ds, value(i))) {
      // Refresh imports reopens the active document over the existing connection.
      // Recheck the new imported declaration; reconnecting or requeueing fails.
      report.importRefreshes++
      editor.refresh(corrected)
      ds = await editor.checked()
    }
    assert(
      proves(ds, value(i)),
      'Lean did not observe the collaborator’s saved imported declaration',
    )
    await editor.goal(corrected)
    assert.equal(
      (await api(account, file(project.id, editor.file))).content,
      corrected,
    )
  })
  await placementBarrier('finalPlacements', active)
  report.verifiedSaves = users
  report.allVerifiedMs = Math.round(performance.now() - started)
  if (queueProbe) await verifyPromotion(active, participants[users])
} catch (error) {
  report.error = error.message
} finally {
  cleaning = true
  for (const socket of [...sockets, ...editors.map((e) => e.socket)])
    socket.terminate()
  const cleanupErrors = []
  if (participants.length) {
    try {
      await waitForEvidence(
        async () => {
          const remaining = await repositoryPlacements(
            dataDir,
            participants,
            !localProbe,
          )
          return (
            !remaining.local.length &&
            !remaining.remote.length &&
            !remaining.pending
          )
        },
        'editor placements drained',
        60000,
      )
    } catch (error) {
      cleanupErrors.push(error.message)
    }
  }
  for (const project of projects) {
    try {
      const current = await api(project.owner, scope(project.id))
      assert.equal(current.name, project.name)
      assert.equal(current.owner, project.owner.id)
      const receipt = await api(project.owner, scope(project.id) + '/trash', {})
      assert.equal(receipt.projectId, project.id)
      assert.equal(receipt.kind, 'project')
      await api(
        project.owner,
        '/api/trash/' + receipt.trashId + '/delete-forever',
        {},
      )
      assert(
        !(await api(project.owner, '/api/projects')).some(
          (p) => p.id === project.id,
        ),
      )
      assert(
        !(await api(project.owner, '/api/trash')).some(
          (r) => r.trashId === receipt.trashId,
        ),
      )
    } catch (error) {
      cleanupErrors.push(error.message)
    }
  }
  report.cleanupErrors = cleanupErrors
  report.passed =
    !report.error && !cleanupErrors.length && report.verifiedSaves === users
  await fs.writeFile(resultFile, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  console.log(JSON.stringify(report))
}
assert(
  report.passed,
  'Repository editor acceptance failed; see the private report',
)
