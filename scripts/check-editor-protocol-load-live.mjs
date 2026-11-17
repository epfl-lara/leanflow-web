// Opt-in API/LSP acceptance with real ordinary users and Lean processes.
// This measures server concurrency; it does not launch browser instances.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
  compileLoadFixture,
  compileLoadWorkloads,
  loadTestSetting,
} from './lib/compile-load-fixture.mjs'

const users = Number(loadTestSetting('STUDIO_LOAD_USERS'))
const expectedCapacity = Number(
  process.env.STUDIO_LOAD_EXPECTED_EDITOR_CAPACITY || users,
)
assert(Number.isSafeInteger(expectedCapacity) && expectedCapacity >= users)
const { state, directory, origin } = await compileLoadFixture({ users })
const report = {
  passed: false,
  kind: 'API and LSP, no browsers',
  users,
  runTag: state.runTag,
  inferenceRequests: 0,
  sessions: [],
  jobs: [],
  probes: [],
  rateLimits: [],
  errors: [],
}
const sessions = []
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
let cleaning = false,
  probeTimer,
  probeTask = Promise.resolve(),
  probing = false
const attempt = randomUUID()
async function progress(phase) {
  const filename = path.join(directory, 'editor-protocol-progress.json')
  const temporary = filename + '.' + attempt
  await fs.writeFile(
    temporary,
    JSON.stringify({
      runTag: state.runTag,
      attempt,
      phase,
      users,
      at: new Date().toISOString(),
    }) + '\n',
    { mode: 0o600, flag: 'wx' },
  )
  await fs.rename(temporary, filename)
}
async function until(check, label, timeout = 300000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const broken = sessions.find(
      (s) => s.error || (!cleaning && s.row.closes.length),
    )
    if (broken)
      throw broken.error || new Error('Editor disconnected: ' + broken.row.user)
    if (await check()) return
    await delay(100)
  }
  throw new Error('Timed out: ' + label)
}
async function api(
  session,
  endpoint,
  body,
  expected = 200,
  method = body === undefined ? 'GET' : 'POST',
) {
  assert(
    /^\/api\/(?:session$|projects$|projects\/[a-f0-9-]{36}\/(?:file\?path=(?:Main\.lean|Workload\.lean|lean-toolchain)$|check$)|jobs\/[a-zA-Z0-9_-]+(?:\/stop)?$)/.test(
      endpoint,
    ),
    'Only fixture project/check APIs are allowed',
  )
  const start = performance.now()
  for (let retry = 0; ; retry++) {
    const response = await fetch(origin + endpoint, {
      method,
      headers: {
        Authorization: 'Bearer ' + session.account.token,
        'Content-Type': 'application/json',
        Origin: origin,
        'X-LeanFlow-User': session.account.id,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000),
    })
    const value = await response.json()
    // A 429 save is rejected before writing. Its expected hash also protects
    // against duplicates. Never retry a check submission or an ambiguous error.
    const retryable =
      method === 'GET' ||
      (method === 'PUT' && typeof body?.expectedHash === 'string')
    if (retryable && response.status === 429 && retry < 12) {
      const retrySeconds = Number(response.headers.get('Retry-After'))
      const waitMs =
        Number.isFinite(retrySeconds) && retrySeconds > 0
          ? Math.min(retrySeconds * 1000, 10000)
          : 1000
      report.rateLimits.push({
        user: session.row.user,
        method,
        retry: retry + 1,
        waitMs,
      })
      await delay(waitMs + session.row.user * 7)
      continue
    }
    assert.equal(
      response.status,
      expected,
      endpoint + ': ' + (value.error || response.status),
    )
    return { value, ms: performance.now() - start }
  }
}
const filePath = (project, file = 'Main.lean') =>
  '/api/projects/' + project.id + '/file?path=' + file
const send = (s, message) =>
  s.socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
function diagnostics(s, version, predicate) {
  return s.messages.some(
    (m) =>
      m.method === 'textDocument/publishDiagnostics' &&
      m.params.uri === 'file:///workspace/Main.lean' &&
      m.params.version === version &&
      predicate(m.params.diagnostics),
  )
}
try {
  for (const [index, account] of state.accounts.entries()) {
    const s = {
      account,
      messages: [],
      row: { user: index + 1, userId: account.id, closes: [] },
    }
    sessions.push(s)
    report.sessions.push(s.row)
    const auth = (await api(s, '/api/session')).value
    assert.equal(auth.user.id, account.id)
    assert.equal(auth.user.role, 'user')
    assert.equal(auth.lemex.configured, false)
    assert.equal(
      auth.capacity.editors,
      expectedCapacity,
      'Expected the configured editor capacity',
    )
    report.capacity ||= auth.capacity
    const [native, toolchain, mathlib] = await Promise.all([
      api(s, filePath(account.projects.native, 'Workload.lean')),
      api(s, filePath(account.projects.native, 'lean-toolchain')),
      api(s, filePath(account.projects.mathlib)),
    ])
    s.original = mathlib.value.content
    s.row.workload = compileLoadWorkloads(account, {
      native: native.value.content,
      toolchain: toolchain.value.content,
      mathlib: s.original,
    })
    const url = new URL('/websocket/' + account.projects.mathlib.id, origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('expectedUserId', account.id)
    s.openedAt = performance.now()
    s.socket = new WebSocket(url, {
      headers: { Authorization: 'Bearer ' + account.token, Origin: origin },
      handshakeTimeout: 60000,
    })
    s.socket.on('error', (error) => {
      s.error = error
    })
    s.socket.on('close', (code) =>
      s.row.closes.push({ code, at: performance.now() }),
    )
    s.socket.on('message', (bytes) => {
      try {
        const message = JSON.parse(String(bytes))
        s.messages.push(message)
        if (s.messages.length > 20000)
          throw new Error('LSP message budget exceeded')
        if (message.method && message.id !== undefined)
          send(s, { id: message.id, result: null })
      } catch (error) {
        s.error = error
      }
    })
    await until(
      () => s.socket.readyState === WebSocket.OPEN,
      'WebSocket ' + s.row.user,
      60000,
    )
    send(s, {
      id: 1,
      method: 'initialize',
      params: {
        processId: null,
        rootUri: 'file:///workspace',
        capabilities: {
          textDocument: { publishDiagnostics: { versionSupport: true } },
        },
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
      },
    })
    await until(
      () => s.messages.some((m) => m.id === 1 && m.result?.capabilities),
      'initialize ' + s.row.user,
    )
    send(s, { method: 'initialized', params: {} })
    send(s, {
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///workspace/Main.lean',
          languageId: 'lean4',
          version: 1,
          text: s.original + '\nexample : Nat := "invalid"\n',
        },
      },
    })
    await until(
      () =>
        diagnostics(s, 1, (ds) =>
          ds.some(
            (d) =>
              d.severity === 1 &&
              String(d.message).includes('invalid') &&
              String(d.message).includes('Nat'),
          ),
        ),
      'genuine Lean error ' + s.row.user,
    )
    s.row.invalidDiagnosticsMs = performance.now() - s.openedAt
    console.log('Real Lean error received for user ' + s.row.user)
    if (!probeTimer)
      probeTimer = setInterval(() => {
        if (probing) return
        probing = true
        probeTask = api(
          sessions[report.probes.length % sessions.length],
          '/api/projects',
        )
          .then((r) => report.probes.push(r.ms))
          .catch((e) => report.errors.push(e.message))
          .finally(() => {
            probing = false
          })
      }, 2000)
  }
  assert.equal(
    sessions.filter((s) => s.socket.readyState === WebSocket.OPEN).length,
    users,
  )
  report.allEditorsActive = users
  report.allEditorsHeldAt = new Date().toISOString()
  await progress('all-editors-held')
  console.log('All ' + users + ' real Lean editors coexist')
  await Promise.all(
    sessions.map(async (s) => {
      const start = performance.now(),
        project = s.account.projects.mathlib
      s.corrected =
        s.original +
        '\n-- protocol load save ' +
        attempt +
        ' user ' +
        s.row.user +
        '\n'
      const current = (await api(s, filePath(project))).value
      await api(
        s,
        filePath(project),
        { content: s.corrected, expectedHash: current.hash },
        200,
        'PUT',
      )
      send(s, {
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: 'file:///workspace/Main.lean', version: 2 },
          contentChanges: [{ text: s.corrected }],
        },
      })
      const marker =
        'LeanFlow verified mirrored file ' + attempt + ' user ' + s.row.user
      const readback =
        s.corrected +
        '\n#eval do\n  let actual ← IO.FS.readFile "Main.lean"\n  if actual == ' +
        JSON.stringify(s.corrected) +
        ' then IO.println ' +
        JSON.stringify(marker) +
        '\n  else throw (IO.userError "Mirrored file differs")\n'
      await until(
        () => diagnostics(s, 2, (ds) => ds.every((d) => d.severity !== 1)),
        'corrected Lean diagnostics ' + s.row.user,
      )
      s.row.firstNoErrorUpdateMs = performance.now() - start
      send(s, {
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: 'file:///workspace/Main.lean', version: 3 },
          contentChanges: [{ text: readback }],
        },
      })
      await until(
        () =>
          diagnostics(
            s,
            3,
            (ds) =>
              ds.every((d) => d.severity !== 1) &&
              ds.some(
                (d) => d.severity === 3 && String(d.message).trim() === marker,
              ),
          ),
        'Lean read of exact saved source ' + s.row.user,
      )
      assert.equal((await api(s, filePath(project))).value.content, s.corrected)
      s.row.mirroredFileVerifiedMs = performance.now() - start
      s.row.saved = true
      s.row.mirroredFileReadByLean = true
      await api(
        s,
        filePath(sessions[s.row.user % users].account.projects.mathlib),
        undefined,
        users === 1 ? 200 : 404,
      )
    }),
  )
  report.allSavesVerifiedAt = new Date().toISOString()
  await progress('all-saves-verified')
  console.log(
    'All corrections, distinct saves, Lean file reads and account isolation passed',
  )
  await Promise.all(
    sessions.map(async (s) => {
      const kind = s.row.user % 2 ? 'native' : 'mathlib'
      const { value } = await api(
        s,
        '/api/projects/' + s.account.projects[kind].id + '/check',
        { path: kind === 'native' ? 'Workload.lean' : 'Main.lean' },
        202,
      )
      s.job = { user: s.row.user, kind, id: value.id, submittedAt: Date.now() }
      report.jobs.push(s.job)
    }),
  )
  console.log(
    'Submitted ' + report.jobs.length + ' mixed checks with all editors held',
  )
  await until(
    async () => {
      await delay(1000)
      await Promise.all(
        sessions.map(async (s) => {
          if (terminal.has(s.job.status)) return
          const { value } = await api(s, '/api/jobs/' + s.job.id)
          Object.assign(s.job, {
            status: value.status,
            code: value.result?.code ?? null,
            checkMethod: value.checkMethod,
            error: value.error || null,
          })
        }),
      )
      return sessions.every((s) => terminal.has(s.job.status))
    },
    'mixed checks',
    900000,
  )
  for (const s of sessions) {
    assert.equal(s.job.status, 'completed', s.job.error || s.job.id)
    assert.equal(s.job.code, 0)
    if (s.job.kind === 'native') assert.equal(s.job.checkMethod, 'lake-check')
    assert.equal(s.socket.readyState, WebSocket.OPEN)
  }
  report.checksFinishedAt = new Date().toISOString()
  await progress('checks-finished')
  report.passed = true
} catch (error) {
  report.errors.push(error.stack || error.message)
  for (const s of sessions)
    s.row.lastDiagnostics = s.messages
      .filter((m) => m.method === 'textDocument/publishDiagnostics')
      .slice(-3)
      .map((m) => m.params)
} finally {
  clearInterval(probeTimer)
  await probeTask
  report.webSocketClosesBeforeCleanup = sessions.reduce(
    (count, s) => count + s.row.closes.length,
    0,
  )
  cleaning = true
  for (const s of sessions)
    if (s.socket?.readyState < WebSocket.CLOSING)
      s.socket.close(1000, 'Load test finished')
  for (const s of sessions)
    if (s.socket) {
      await until(
        () => s.socket.readyState === WebSocket.CLOSED,
        'socket cleanup',
        15000,
      ).catch((e) => {
        report.errors.push(e.message)
        s.socket.terminate()
      })
      if (s.job && !terminal.has(s.job.status))
        await api(s, '/api/jobs/' + s.job.id + '/stop', {}).catch((e) =>
          report.errors.push(e.message),
        )
    }
  report.passed &&= report.errors.length === 0
  const sorted = [...report.probes].sort((a, b) => a - b)
  report.probeSummary = {
    count: sorted.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    maxMs: sorted.at(-1) ?? null,
  }
  await fs.writeFile(
    path.join(directory, 'editor-protocol-load.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      users,
      kind: report.kind,
      errors: report.errors,
    }),
  )
}
assert(report.passed, 'Protocol load acceptance failed; see private report')
