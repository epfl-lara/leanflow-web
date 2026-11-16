// Explicitly opted-in browser/LSP load test, using disposable ordinary accounts.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'
import {
  compileLoadFixture,
  loadTestSetting,
} from './lib/compile-load-fixture.mjs'

const users = Number(loadTestSetting('STUDIO_LOAD_USERS'))
const { state, directory, origin } = await compileLoadFixture({ users })
const report = {
  passed: false,
  users,
  runTag: state.runTag,
  inferenceRequests: 0,
  modelMetadataFixture: true,
  realAuth: true,
  realLeanDiagnostics: true,
  sessions: [],
  jobs: [],
  errors: [],
  probes: [],
  runtimeSamples: [],
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
})
const sessions = []
const attempt = randomUUID()
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label, timeout = 300000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error('Timed out: ' + label)
}
async function get(session, endpoint, status = 200) {
  const start = performance.now()
  for (let n = 0; ; n++) {
    const response = await session.context.request.get(origin + endpoint, {
      headers: { 'X-LeanFlow-User': session.account.id },
      timeout: 60000,
    })
    const value = await response.json()
    if (response.status() === 429 && n < 8) {
      await sleep(1000)
      continue
    }
    assert.equal(
      response.status(),
      status,
      endpoint + ': ' + (value.error || ''),
    )
    return { value, ms: performance.now() - start }
  }
}
let probeTimer,
  probeTask = Promise.resolve(),
  sampling = false
try {
  for (const [index, account] of state.accounts.entries()) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    const session = {
      account,
      context,
      index: index + 1,
      version: 0,
      diagnostics: [],
      sockets: [],
      openedAt: performance.now(),
    }
    sessions.push(session)
    const row = {
      user: index + 1,
      userId: account.id,
      diagnostics: [],
      webSocketCloses: [],
    }
    report.sessions.push(row)
    session.row = row
    const project = account.projects.mathlib
    for (const pattern of [
      '**/api/projects/*/runs',
      '**/api/chats/*/runs',
      '**/api/runs/*/messages',
    ])
      await context.route(pattern, async (route) => {
        if (route.request().method() === 'POST') {
          report.inferenceRequests++
          await route.abort()
        } else await route.continue()
      })
    // Only model metadata is a fixture. No account has a provider key; files,
    // authentication, WebSockets, diagnostics, compilation and saves stay real.
    await context.route('**/api/session', async (route) => {
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      const value = await response.json()
      assert.equal(value.user.id, account.id)
      assert.equal(value.user.role, 'user')
      assert.equal(value.lemex.configured, false)
      const model = {
        id: 'load-no-inference',
        name: 'Inference disabled',
        reasoningEfforts: [],
      }
      await route.fulfill({
        response,
        json: {
          ...value,
          models: [model],
          defaultModel: model.id,
          savedModels: [model.id],
          lemex: { ...value.lemex, configured: true, modelError: null },
        },
      })
    })
    const page = await context.newPage()
    session.page = page
    page.setDefaultTimeout(120000)
    page.on('pageerror', (error) =>
      report.errors.push({ user: index + 1, message: error.message }),
    )
    page.on('websocket', (ws) => {
      if (new URL(ws.url()).pathname !== '/websocket/' + project.id) return
      session.sockets.push(ws)
      ws.on('framesent', (event) => {
        try {
          const m = JSON.parse(String(event.payload))
          if (
            ['textDocument/didOpen', 'textDocument/didChange'].includes(
              m.method,
            )
          )
            session.version = m.params.textDocument.version
        } catch {}
      })
      ws.on('framereceived', (event) => {
        try {
          const m = JSON.parse(String(event.payload))
          if (
            m.method === 'textDocument/publishDiagnostics' &&
            m.params.uri === 'file:///workspace/Main.lean'
          ) {
            const item = {
              version: m.params.version,
              errors: m.params.diagnostics.filter((d) => d.severity === 1)
                .length,
              at: performance.now(),
            }
            session.diagnostics.push(item)
          }
        } catch {}
      })
      ws.on('close', () => row.webSocketCloses.push(performance.now()))
    })
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.evaluate(
      ({ id }) => {
        localStorage.setItem('lemex-project', id)
        localStorage.setItem('lemex-file-' + id, 'Main.lean')
      },
      { id: project.id },
    )
    await page.getByLabel('Access token', { exact: true }).fill(account.token)
    const login = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/login' &&
        r.request().method() === 'POST',
    )
    await page
      .getByRole('button', { name: 'Open workspace', exact: true })
      .click()
    const response = await login
    assert.equal(response.status(), 200)
    await response.finished()
    const auth = (await get(session, '/api/session')).value
    assert.equal(auth.user.id, account.id)
    assert.equal(auth.user.role, 'user')
    assert.equal(auth.lemex.configured, false)
    report.profile ||= { capacity: auth.capacity, runtime: auth.runtime.limits }
    session.original = (
      await get(session, '/api/projects/' + project.id + '/file?path=Main.lean')
    ).value.content
    assert(
      session.original.startsWith(
        'import Mathlib\nnamespace User' +
          String(index + 1).padStart(2, '0') +
          '\n',
      ),
    )
    await page.locator('.monaco-editor textarea').first().waitFor()
    await page.locator('.editor-loading').waitFor({ state: 'hidden' })
    row.browserReadyMs = performance.now() - session.openedAt
    console.log(
      'Browser ' +
        (index + 1) +
        ' authenticated; waiting for real Lean diagnostics',
    )
    if (!probeTimer)
      probeTimer = setInterval(() => {
        if (sampling) return
        sampling = true
        probeTask = (async () => {
          const selected = sessions[report.probes.length % sessions.length]
          const result = await get(selected, '/api/projects')
          report.probes.push(result.ms)
          const current = (await get(selected, '/api/session')).value.runtime
          report.runtimeSamples.push({
            active: current.active,
            queued: current.queued,
            interactive: current.workloads?.active?.interactive,
            usedMemoryBytes: current.limits?.usedMemoryBytes,
          })
        })()
          .catch((error) => report.errors.push({ probe: error.message }))
          .finally(() => {
            sampling = false
          })
      }, 1500)
  }
  await Promise.all(
    sessions.map(async (session) => {
      await until(
        () =>
          session.diagnostics.some(
            (d) => d.version === session.version && d.errors === 0,
          ),
        'initial diagnostics user ' + session.index,
      )
      assert.equal(session.sockets.length, 1, 'One actual Lean server per user')
      session.row.initialDiagnosticsMs =
        session.diagnostics.find(
          (d) => d.version === session.version && d.errors === 0,
        ).at - session.openedAt
    }),
  )
  assert.equal(sessions.length, users)
  const live = (await get(sessions[0], '/api/session')).value.runtime
  assert(
    live.workloads.active.interactive >= users,
    'All Lean editors must coexist',
  )
  report.allEditorsActive = live.workloads.active.interactive
  await Promise.all(
    sessions.map(async (session) => {
      const baseline = session.version,
        start = performance.now()
      await session.page.locator('.monaco-editor textarea').first().focus()
      await session.page.keyboard.press(editorShortcuts.documentEnd)
      await session.page.keyboard.insertText(
        '\nexample : False := by trivial\n',
      )
      await until(
        () => session.version > baseline,
        'sent edit ' + session.index,
      )
      const changed = session.version
      await until(
        () =>
          session.diagnostics.some((d) => d.version >= changed && d.errors > 0),
        'error diagnostics ' + session.index,
      )
      session.row.errorDiagnosticsMs = performance.now() - start
    }),
  )
  await Promise.all(
    sessions.map(async (session) => {
      const baseline = session.version,
        start = performance.now()
      const restored =
        session.original +
        '\n-- editor load save ' +
        attempt +
        ' user ' +
        session.index +
        '\n'
      await session.page.locator('.monaco-editor textarea').first().focus()
      await session.page.keyboard.press('ControlOrMeta+A')
      await session.page.keyboard.insertText(restored)
      await until(
        () => session.version > baseline,
        'sent correction ' + session.index,
      )
      const changed = session.version
      await until(
        () =>
          session.diagnostics.some(
            (d) => d.version >= changed && d.errors === 0,
          ),
        'corrected diagnostics ' + session.index,
      )
      session.row.correctedDiagnosticsMs = performance.now() - start
      await until(async () => {
        const file = await get(
          session,
          '/api/projects/' +
            session.account.projects.mathlib.id +
            '/file?path=Main.lean',
        )
        return file.value.content === restored
      }, 'durable save ' + session.index)
      session.row.saved = true
    }),
  )
  await Promise.all(
    sessions.map(async (session) => {
      const kind = session.index % 2 ? 'native' : 'mathlib',
        project = session.account.projects[kind]
      const response = await session.context.request.post(
        origin + '/api/projects/' + project.id + '/check',
        {
          data: { path: kind === 'native' ? 'Workload.lean' : 'Main.lean' },
          headers: { 'X-LeanFlow-User': session.account.id },
          timeout: 60000,
        },
      )
      const value = await response.json()
      assert.equal(response.status(), 202, value.error)
      const item = {
        user: session.index,
        kind,
        id: value.id,
        submittedAt: Date.now(),
      }
      report.jobs.push(item)
      session.job = item
      const foreign = sessions[session.index % users]
      await get(
        session,
        '/api/projects/' +
          foreign.account.projects.mathlib.id +
          '/file?path=Main.lean',
        404,
      )
    }),
  )
  const jobsStarted = Date.now()
  await until(
    async () => {
      for (const session of sessions) {
        if (terminal.has(session.job.status)) continue
        const value = (await get(session, '/api/jobs/' + session.job.id)).value
        Object.assign(session.job, {
          status: value.status,
          code: value.result?.code ?? null,
          checkMethod: value.checkMethod,
          error: value.error || null,
        })
      }
      return sessions.every((s) => terminal.has(s.job.status))
    },
    'mixed compile burst',
    900000,
  )
  report.compileBurstMs = Date.now() - jobsStarted
  for (const session of sessions) {
    assert.equal(session.job.status, 'completed', JSON.stringify(session.job))
    assert.equal(session.job.code, 0)
    assert.equal(
      session.row.webSocketCloses.length,
      0,
      'Lean editor disconnected under load',
    )
    assert.equal(await session.page.locator('.editor-failure').count(), 0)
    const foreign = sessions[session.index % users]
    await get(session, '/api/jobs/' + foreign.job.id, 404)
    session.row.diagnostics = session.diagnostics.map(
      ({ version, errors }) => ({ version, errors }),
    )
  }
  report.passed = true
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  clearInterval(probeTimer)
  await probeTask
  if (!report.passed)
    for (const session of sessions) {
      if (session.job && !terminal.has(session.job.status))
        await session.context.request
          .post(
            origin +
              '/api/projects/' +
              session.account.projects[session.job.kind].id +
              '/stop',
            {
              data: {},
              headers: { 'X-LeanFlow-User': session.account.id },
            },
          )
          .catch(() => {})
    }
  for (const session of sessions) await session.context.close().catch(() => {})
  await browser.close()
  if (report.errors.length || report.inferenceRequests) {
    report.passed = false
    process.exitCode = 1
  }
  const sorted = [...report.probes].sort((a, b) => a - b)
  report.probeSummary = {
    count: sorted.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    maxMs: sorted.at(-1) ?? null,
  }
  await fs.writeFile(
    path.join(directory, 'editor-load-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      users,
      allEditorsActive: report.allEditorsActive,
      jobs: report.jobs.length,
      failure: report.failure,
      errors: report.errors,
      probes: report.probeSummary,
      inferenceRequests: report.inferenceRequests,
    }),
  )
}
