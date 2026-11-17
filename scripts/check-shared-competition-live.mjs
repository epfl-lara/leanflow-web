#!/usr/bin/env node
// Opt-in acceptance for one disposable, shared two-file Mathlib project.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
  connectProjectDocumentPeer,
  waitForDocument,
} from './lib/project-document-peer.mjs'
import { loadTestSetting } from './lib/compile-load-fixture.mjs'

assert.equal(process.env.STUDIO_RUN_LIVE_LOAD_TEST, '1')
const origin = new URL(loadTestSetting('STUDIO_LOAD_ORIGIN')).origin
assert(
  origin.startsWith('https://') ||
    /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin),
)
const file = loadTestSetting('STUDIO_LOAD_FIXTURE')
const stat = await fs.lstat(file)
assert(
  stat.isFile() &&
    stat.nlink === 1 &&
    !(stat.mode & 0o077) &&
    stat.uid === process.getuid(),
)
const { tag, accounts, project, prepared, playground, secondary } = JSON.parse(
  await fs.readFile(file, 'utf8'),
)
assert(/^LF shared \d{8} [a-f0-9]{8}$/.test(tag) && prepared)
assert.equal(accounts.length, 25)
assert.equal(new Set(accounts.map((a) => a.id)).size, 25)
assert.match(project.id, /^[a-f0-9-]{36}$/)
assert.equal(project.name, tag + ' Packing')
const root = '/api/projects/' + project.id
const files = ['Main.lean', 'Main/Packing.lean']
const reportfile = path.join(
  loadTestSetting('STUDIO_LOAD_OUTPUT'),
  'shared-competition.json',
)
const phase = process.env.STUDIO_LOAD_CHECK_SCOPE || ''
assert(['', 'file'].includes(phase))
const mixed = process.env.STUDIO_LOAD_EXTRA_WINDOW === '1'
const secondWindows = []
const checkScope = phase === 'file'
const outputDirectory = await fs.lstat(path.dirname(reportfile))
assert(
  outputDirectory.isDirectory() &&
    !(outputDirectory.mode & 0o077) &&
    outputDirectory.uid === process.getuid(),
)
const nonce = randomBytes(5).toString('hex')
const sockets = new Set(),
  sessions = []
const started = performance.now()
const elapsed = () => Math.round(performance.now() - started)
let problems = [],
  active = 0,
  release = false
const report = {
  participants: accounts.length,
  collaborativeWrites: 0,
  verifiedFiles: 0,
  initialized: 0,
  maxActive: 0,
  maxWaiting: 0,
  waitMs: [],
  participantChecks: 0,
  independentCheckMs: [],
  unexpectedCloses: 0,
  providerRequests: 0,
}
async function api(a, endpoint, body) {
  const res = await fetch(origin + endpoint, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + a.token,
      Origin: origin,
      'X-LeanFlow-User': a.id,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  })
  const value = await res.json()
  assert(res.ok, endpoint + ' ' + res.status + ' ' + (value.error || ''))
  return value
}
async function wait(pred, label, timeout = 480000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (problems.length) throw problems[0]
    if (await pred()) return
    await delay(60)
  }
  throw new Error('Timed out waiting for ' + label)
}
const marker = (index, f) =>
  '-- shared-load ' + nonce + ' ' + index + ' ' + files.indexOf(f) + '\n'
function monitor(ws, s, kind) {
  ws.on('error', (e) => problems.push(e))
  ws.on('close', (code) => {
    if (!release && !(kind === 'Lean' && s.finished)) {
      report.unexpectedCloses++
      problems.push(
        new Error(
          kind +
            ' closed unexpectedly for participant ' +
            s.index +
            ' (' +
            code +
            ')',
        ),
      )
    }
  })
}
function openLean(s, projectId = project.id) {
  const url = new URL('/websocket/' + projectId, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('expectedUserId', s.account.id)
  const ws = new WebSocket(url, {
    headers: { Authorization: 'Bearer ' + s.account.token, Origin: origin },
    handshakeTimeout: 30000,
  })
  sockets.add(ws)
  monitor(ws, s, 'Lean')
  s.send = (msg) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }))
  s.socket = ws
  s.diagnostics = new Map()
  s.ack = new Set()
  s.opened = performance.now()
  ws.on('open', () =>
    s.send({
      id: 1,
      method: 'initialize',
      params: {
        processId: null,
        rootUri: 'file:///workspace',
        capabilities: {
          textDocument: { publishDiagnostics: { versionSupport: true } },
        },
        workspaceFolders: [{ name: 'workspace', uri: 'file:///workspace' }],
      },
    }),
  )
  ws.on('message', (buffer) => {
    const m = JSON.parse(buffer.toString())
    if (m.method && m.id !== undefined) s.send({ id: m.id, result: null })
    if (m.error && m.id !== undefined) {
      problems.push(
        new Error(
          'Lean request ' +
            m.id +
            ' failed for participant ' +
            s.index +
            ': ' +
            String(m.error.message),
        ),
      )
      return
    }
    if (m.id === 1 && m.result?.capabilities) {
      s.initialized = true
      s.waiting = false
      if (!s.extra) {
        report.initialized++
        active++
        report.maxActive = Math.max(active, report.maxActive)
        report.waitMs.push(Math.round(performance.now() - s.opened))
      }
      s.send({ method: 'initialized', params: {} })
    } else if (m.method === '$/leanflow/editorQueue') {
      s.waiting = m.params.state === 'waiting'
      report.maxWaiting = Math.max(
        report.maxWaiting,
        sessions.filter((x) => x.waiting).length,
      )
    } else if (m.method === 'textDocument/publishDiagnostics') {
      const { uri, version, diagnostics, isIncremental } = m.params
      const key = uri + ':' + version
      s.diagnostics.set(
        key,
        isIncremental
          ? [...(s.diagnostics.get(key) || []), ...diagnostics]
          : diagnostics,
      )
    } else if (m.id !== undefined) s.ack.add(m.id)
  })
}
async function testSession(s, source) {
  await wait(() => s.initialized, 'Lean admission ' + s.index)
  for (const f of files)
    s.send({
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///workspace/' + f,
          languageId: 'lean4',
          version: 1,
          text: source[f] + '\nexample : Nat := "invalid"\n',
        },
      },
    })
  for (const f of files)
    await wait(
      () =>
        s.diagnostics
          .get('file:///workspace/' + f + ':1')
          ?.some(
            (d) =>
              d.severity === 1 &&
              /type mismatch/i.test(d.message) &&
              d.message.includes('invalid'),
          ),
      'real error in ' + f + ' for ' + s.index,
    )
  for (const [i, f] of files.entries()) {
    const uri = 'file:///workspace/' + f
    s.send({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: source[f] }],
      },
    })
    s.send({
      id: 10 + i,
      method: 'textDocument/waitForDiagnostics',
      params: { uri, version: 2 },
    })
  }
  for (const [i, f] of files.entries()) {
    await wait(
      () =>
        s.ack.has(10 + i) && s.diagnostics.has('file:///workspace/' + f + ':2'),
      'corrected ' + f + ' for ' + s.index,
    )
    assert(
      !s.diagnostics
        .get('file:///workspace/' + f + ':2')
        .some((d) => d.severity === 1),
      'Unexpected compiler error after correction',
    )
    report.verifiedFiles++
  }
  // A participant finishes this turn. No live or queued participant is preempted.
  await finishLean(s)
  active--
}
async function finishLean(s) {
  s.send({ id: 20, method: 'shutdown', params: null })
  await wait(() => s.ack.has(20), 'Lean shutdown ' + s.index, 15000)
  s.finished = true
  s.send({ method: 'exit' })
  s.socket.close()
}

async function independent(s, target, projectRoot = root) {
  const submitted = performance.now()
  const job = await api(s.account, projectRoot + '/check', {
    path: target,
    scope: 'file',
  })
  assert.equal(job.checkScope, 'file')
  assert.equal(job.projectId, projectRoot.split('/').at(-1))
  await wait(async () => {
    const v = await api(s.account, '/api/jobs/' + job.id)
    if (v.status === 'failed' || v.status === 'cancelled')
      throw new Error(
        'Selected file check ' +
          v.status +
          ' for participant ' +
          s.index +
          ': ' +
          String(v.error || v.log || '').slice(-450),
      )
    if (v.status === 'completed') {
      assert.equal(v.checkMethod, 'lean-file')
      return true
    }
    await delay(650)
    return false
  }, 'selected-file check ' + s.index)
  report.participantChecks++
  report.independentCheckMs.push(Math.round(performance.now() - submitted))
}
try {
  for (const [index, account] of accounts.entries()) {
    assert.equal(account.name, tag + ' P' + String(index + 1).padStart(2, '0'))
    assert.match(account.id, /^[a-f0-9]{24}$/)
    const [session, p] = await Promise.all([
      api(account, '/api/session'),
      api(account, root),
    ])
    assert.equal(session.user.id, account.id)
    assert.equal(session.user.role, 'user')
    assert.equal(session.lemex.configured, false)
    assert.equal(p.name, project.name)
    assert.equal(p.owner, accounts[0].id)
    assert.equal(p.accessRole, index ? 'editor' : 'admin')
    sessions.push({ index, account })
  }
  const originals = Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        (await api(accounts[0], root + '/file?path=' + encodeURIComponent(f)))
          .content,
      ]),
    ),
  )
  for (const f of files)
    assert(originals[f].includes('namespace CompetitionPacking'))
  const peers = await Promise.all(
    sessions.map(async (s) => {
      const p = await connectProjectDocumentPeer(
        {
          origin,
          projectId: project.id,
          token: s.account.token,
          sockets,
          timeoutMs: 45000,
        },
        { name: files[0] },
      )
      monitor(p.ws, s, 'Collaboration')
      await p.open(files[1])
      return p
    }),
  )
  if (mixed) {
    assert(checkScope)
    assert.match(playground.id, /^[a-f0-9-]{36}$/)
    assert.equal(playground.name, tag + ' Shared playground.lean')
    const view = await api(accounts[0], '/api/projects/' + playground.id)
    assert.equal(view.owner, accounts[0].id)
    assert.equal(view.kind, 'single-file')
    assert.equal(view.name, playground.name)
    const starter = (
      await api(
        accounts[0],
        '/api/projects/' + playground.id + '/file?path=Main.lean',
      )
    ).content
    await Promise.all(
      sessions.map(async ({ index, account }) => {
        const s = { index, account, extra: true }
        secondWindows.push(s)
        openLean(s, playground.id)
        await wait(() => s.initialized, 'school playground ' + index)
        const uri = 'file:///workspace/Main.lean'
        s.send({
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri,
              version: 1,
              languageId: 'lean4',
              text: starter,
            },
          },
        })
        s.send({
          id: 9,
          method: 'textDocument/waitForDiagnostics',
          params: { uri, version: 1 },
        })
        await wait(
          () => s.ack.has(9) && s.diagnostics.has(uri + ':1'),
          'first window diagnostics ' + index,
        )
        assert(!s.diagnostics.get(uri + ':1').some((d) => d.severity === 1))
      }),
    )
    report.heldPlaygroundEditors = secondWindows.length
    console.log(
      '25 participants have a checked first window in the shared playground.',
    )
  }
  for (const s of sessions) openLean(s)
  await wait(
    () => sessions.every((s) => s.initialized || s.waiting),
    'all 25 connected or in line',
  )
  const editStart = performance.now()
  await Promise.all(
    peers.flatMap((peer, index) =>
      files.map(async (f) => {
        const id = peer.edit(
          (text) => text.insert(text.length, marker(index, f)),
          f,
        )
        const ack = await peer.ack(id)
        assert.equal(ack.type, 'document', ack.message)
        report.collaborativeWrites++
      }),
    ),
  )
  const source = Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        (await api(accounts[0], root + '/file?path=' + encodeURIComponent(f)))
          .content,
      ]),
    ),
  )
  for (const f of files) {
    assert(source[f].startsWith(originals[f]))
    assert.deepEqual(
      source[f].slice(originals[f].length).trimEnd().split('\n').sort(),
      sessions.map((s) => marker(s.index, f).trimEnd()).sort(),
    )
    await waitForDocument(
      () =>
        peers.every(
          (p) =>
            p.documents.get(f).doc.getText('source').toString() === source[f],
        ),
      'all peers see both files',
      30000,
    )
  }
  report.allEditsConvergedMs = Math.round(performance.now() - editStart)
  report.heldDuringEdits = peers.filter(
    (p) => p.ws.readyState === WebSocket.OPEN,
  ).length
  console.log(
    'All 50 shared edits acknowledged, saved and converged; ' +
      report.maxWaiting +
      ' connections observed waiting.',
  )
  if (checkScope) {
    // Keep every editor tab open. Even the last person in line must be able to
    // compile both files without persuading someone else to leave the project.
    const began = performance.now()
    for (let round = 0; round < files.length; round++)
      await Promise.all(
        sessions.map((s) =>
          independent(s, files[(s.index + round) % files.length]),
        ),
      )
    report.allIndependentChecksMs = Math.round(performance.now() - began)
    report.waitingWhenChecksFinished = sessions.filter((s) => s.waiting).length
    assert(report.waitingWhenChecksFinished > 0)
    assert.equal(report.participantChecks, 50)
  }
  if (mixed) {
    assert.equal(secondary.name, tag + ' Modules')
    assert.match(secondary.id, /^[a-f0-9-]{36}$/)
    const other = '/api/projects/' + secondary.id
    const p = await api(accounts[1], other)
    assert.equal(p.name, secondary.name)
    assert.equal(p.owner, accounts[0].id)
    assert.equal(p.accessRole, 'editor')
    const input = (await api(accounts[1], other + '/file?path=Main.lean'))
      .content
    assert(input.includes('import Main.Geometry'))
    const unfinished = (
      await api(accounts[1], other + '/file?path=Unfinished.lean')
    ).content
    assert(unfinished.includes('"unfinished sibling"'))
    await independent(sessions[1], 'Main.lean', other)
    report.crossRepositoryImportCheck = true
    assert(secondWindows.every((s) => s.socket.readyState === WebSocket.OPEN))
    report.leanWindowsHeld = sessions.length + secondWindows.length
    await Promise.all(secondWindows.map(finishLean))
  }
  await Promise.all(sessions.map((s) => testSession(s, source)))
  assert.equal(report.verifiedFiles, 50)
  assert(peers.every((p) => p.ws.readyState === WebSocket.OPEN))
  report.elapsedMs = elapsed()
  report.passed = true
} finally {
  release = true
  for (const ws of sockets)
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
  await fs.writeFile(reportfile, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  })
}
console.log(JSON.stringify(report))
