import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

import {
  compileLoadFixture,
  compileLoadWorkloads,
} from './lib/compile-load-fixture.mjs'

const {
  state: credentials,
  directory,
  origin,
  rounds,
} = await compileLoadFixture()
const stubModels = process.env.STUDIO_LOAD_STUB_MODELS === '1'
const model = {
  id: 'compile-test-no-inference',
  name: 'Compile test, inference disabled',
  reasoningEfforts: [],
}
const report = {
  passed: false,
  users: 10,
  runTag: credentials.runTag,
  realAuth: true,
  modelMetadataFixture: stubModels,
  inferenceRequests: 0,
  sourceBackpressureRetries: 0,
  workloads: [],
  errors: [],
  checks: [],
  sessions: [],
  rounds: [],
  probeLatenciesMs: [],
  browserAttempt: randomUUID(),
}
const contexts = [],
  sessions = []
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
let browser
async function until(read, predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out: ' + label)
}
async function get(session, endpoint, { status = 200, retries = 8 } = {}) {
  const start = performance.now()
  for (let attempt = 0; ; attempt++) {
    const response = await session.context.request.get(origin + endpoint, {
      timeout: 60000,
      headers: { 'X-LeanFlow-User': session.account.id },
    })
    const value = await response.json()
    if (response.status() === 429 && attempt < retries) {
      report.sourceBackpressureRetries =
        (report.sourceBackpressureRetries || 0) + 1
      await new Promise((resolve) => setTimeout(resolve, 500))
      continue
    }
    assert.equal(
      response.status(),
      status,
      endpoint + ': ' + (value.error || ''),
    )
    return { value, elapsedMs: Math.round(performance.now() - start) }
  }
}
async function open(session, kind) {
  const project = session.account.projects[kind]
  await session.page.evaluate(
    ({ id, file }) => {
      localStorage.setItem('lemex-project', id)
      localStorage.setItem('lemex-file-' + id, file)
    },
    { id: project.id, file: kind === 'native' ? 'Workload.lean' : 'Main.lean' },
  )
  await session.page.goto(origin, { waitUntil: 'domcontentloaded' })
  await session.page.locator('.file-toolbar').waitFor({ timeout: 90000 })
  await until(
    () => session.page.locator('.lean-check-button').isEnabled(),
    Boolean,
    'compile button for user ' + session.index,
  )
  session.kind = kind
}
async function compileRound(label, kinds) {
  const round = { label, startedAt: Date.now(), cases: [], passed: false }
  report.rounds.push(round)
  await Promise.all(
    sessions.map((session, index) => open(session, kinds[index])),
  )
  for (const session of sessions) {
    const foreign =
      sessions[session.index % sessions.length].account.projects[session.kind]
    await get(
      session,
      '/api/projects/' +
        foreign.id +
        '/file?path=' +
        (session.kind === 'native' ? 'Workload.lean' : 'Main.lean'),
      { status: 404 },
    )
  }
  const submitted = await Promise.all(
    sessions.map(async (session) => {
      const pending = session.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            '/api/projects/' +
              session.account.projects[session.kind].id +
              '/check',
        { timeout: 120000 },
      )
      await session.page
        .locator('.lean-check-button')
        .click({ timeout: 120000 })
      const response = await pending
      assert.equal(response.status(), 202)
      const job = await response.json()
      const item = {
        user: session.index,
        userId: session.account.id,
        kind: session.kind,
        jobId: job.id,
        projectId: session.account.projects[session.kind].id,
        submittedAt: Date.now(),
      }
      round.cases.push(item)
      return { session, item }
    }),
  )
  round.submissionSpreadMs =
    Math.max(...round.cases.map((c) => c.submittedAt)) -
    Math.min(...round.cases.map((c) => c.submittedAt))
  const pending = new Set(submitted)
  const deadline = Date.now() + 900000
  while (pending.size) {
    assert(Date.now() < deadline, 'Browser compile round timed out')
    await Promise.all(
      [...pending].map(async (pair) => {
        const { value } = await get(
          pair.session,
          '/api/jobs/' + pair.item.jobId,
        )
        if (terminal.has(value.status)) {
          Object.assign(pair.item, {
            status: value.status,
            code: value.result?.code ?? null,
            error: value.error || null,
            elapsedMs: Date.now() - round.startedAt,
            checkMethod: value.checkMethod,
          })
          pending.delete(pair)
        }
      }),
    )
    const probes = await Promise.all(
      sessions.map(async (session) => {
        const result = await get(session, '/api/projects')
        assert(
          result.value.some(
            (project) =>
              project.id === session.account.projects[session.kind].id,
          ),
        )
        return result.elapsedMs
      }),
    )
    report.probeLatenciesMs.push(...probes)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  for (const pair of submitted) {
    assert.equal(
      pair.item.status,
      'completed',
      'User ' + pair.item.user + ': ' + pair.item.error,
    )
    assert.equal(pair.item.code, 0)
    await until(
      () => pair.session.page.locator('.lean-check-button').innerText(),
      (text) =>
        text ===
        (pair.session.kind === 'native' ? 'Check Project' : 'Check File'),
      'browser receives completed check',
    )
    const foreign = submitted.find(
      (other) => other.session.account.id !== pair.session.account.id,
    )
    await get(pair.session, '/api/jobs/' + foreign.item.jobId, { status: 404 })
  }
  round.elapsedMs = Date.now() - round.startedAt
  round.passed = true
  console.log(
    JSON.stringify({
      label,
      passed: true,
      users: 10,
      elapsedMs: round.elapsedMs,
      submissionSpreadMs: round.submissionSpreadMs,
    }),
  )
  await fs.writeFile(
    path.join(directory, 'browser-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  )
}
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  })
  for (const [index, account] of credentials.accounts.entries()) {
    assert(account.name.startsWith(credentials.runTag))
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    contexts.push(context)
    // Only the unrelated AI setup/catalog is a browser fixture. Auth, runtime,
    // storage, project/file APIs, collaboration, jobs and Lean remain real.
    if (stubModels)
      await context.route('**/api/session', async (route) => {
        const response = await route.fetch()
        if (response.status() !== 200) return route.fulfill({ response })
        const value = await response.json()
        assert.equal(value.user.id, account.id)
        return route.fulfill({
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
    if (stubModels)
      await context.route('**/api/models', async (route) => {
        const response = await route.fetch()
        assert.equal(response.status(), 200)
        return route.fulfill({
          response,
          json: {
            models: [model],
            defaultModel: model.id,
            savedModels: [model.id],
            providerId: 'compile-test',
            isRcp: false,
          },
        })
      })
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
    const page = await context.newPage()
    page.on('pageerror', (error) =>
      report.errors.push({ user: index + 1, message: error.message }),
    )
    page.setDefaultTimeout(90000)
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Access token', { exact: true }).fill(account.token)
    const signedIn = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/login' &&
        response.request().method() === 'POST',
    )
    await page
      .getByRole('button', { name: 'Open workspace', exact: true })
      .click()
    const loginResponse = await signedIn
    assert.equal(loginResponse.status(), 200)
    await loginResponse.finished()
    const session = { account, context, page, index: index + 1, kind: 'native' }
    const authenticated = (await get(session, '/api/session')).value
    assert.equal(authenticated.user.id, account.id)
    assert.equal(authenticated.user.role, 'user')
    assert.equal(authenticated.user.name, account.name)
    for (const project of Object.values(account.projects)) {
      const actual = (await get(session, '/api/projects/' + project.id)).value
      assert.equal(actual.name, project.name)
    }
    sessions.push(session)
    report.sessions.push({
      user: index + 1,
      userId: account.id,
      role: authenticated.user.role,
      realProviderConfigured: authenticated.lemex.configured,
    })
    await open(session, 'native')
    console.log('Authenticated browser ' + (index + 1) + ' ready')
  }
  assert.notEqual(
    rounds,
    'mathlib',
    'Use the mixed browser round for Mathlib compilation.',
  )
  assert.equal(new Set(report.sessions.map((s) => s.userId)).size, 10)
  for (const session of sessions) {
    const contents = {}
    for (const [name, kind, filename] of [
      ['native', 'native', 'Workload.lean'],
      ['toolchain', 'native', 'lean-toolchain'],
      ['mathlib', 'mathlib', 'Main.lean'],
    ])
      contents[name] = (
        await get(
          session,
          '/api/projects/' +
            session.account.projects[kind].id +
            '/file?path=' +
            filename,
        )
      ).value.content
    report.workloads.push(compileLoadWorkloads(session.account, contents))
  }
  await Promise.all(
    sessions.map(async (session) => {
      const marker =
        '-- browser save user ' + session.index + ' ' + report.browserAttempt
      await session.page
        .locator('.monaco-editor textarea')
        .first()
        .waitFor({ timeout: 120000 })
      await session.page
        .locator('.editor-loading')
        .waitFor({ state: 'hidden', timeout: 120000 })
      await session.page.locator('.monaco-editor textarea').first().focus()
      await session.page.keyboard.press(editorShortcuts.documentEnd)
      await session.page.keyboard.insertText('\n' + marker + '\n')
      await until(
        () =>
          get(
            session,
            '/api/projects/' +
              session.account.projects.native.id +
              '/file?path=Workload.lean',
          ).then((r) => r.value.content),
        (value) => value.includes(marker),
        'concurrent browser edit saved for user ' + session.index,
        120000,
      )
    }),
  )
  report.checks.push(
    'Ten independent browser users edited and durably saved distinct Lean files concurrently',
  )
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (rounds === 'all' || rounds === 'native')
    await compileRound('ten-browser-native-projects', Array(10).fill('native'))
  if (rounds === 'all' || rounds === 'mixed')
    await compileRound(
      'ten-browser-mixed-projects-and-mathlib',
      Array.from({ length: 10 }, (_, i) => (i % 2 ? 'mathlib' : 'native')),
    )
  for (const session of sessions) {
    report.sessions[session.index - 1].visibility = await session.page.evaluate(
      () => document.visibilityState,
    )
    report.sessions[session.index - 1].editorFailures = await session.page
      .locator('.editor-failure')
      .count()
    assert.equal(report.sessions[session.index - 1].editorFailures, 0)
  }
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors))
  assert.equal(report.inferenceRequests, 0)
  report.passed = true
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close()
  if (report.errors.length || report.inferenceRequests) {
    report.passed = false
    process.exitCode = 1
  }
  report.finishedAt = Date.now()
  await fs.writeFile(
    path.join(directory, 'browser-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      users: report.sessions.length,
      checks: report.checks,
      errors: report.errors,
      failure: report.failure,
      inferenceRequests: report.inferenceRequests,
    }),
  )
}
