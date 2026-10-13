// Isolate chat/browser regressions from real workspaces, provider calls, and Lean.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'

export const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))
export async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(75)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

// Match the HTTP projection: history is a transcript, not a full run snapshot.
// Keeping this narrow catches missing lazy hydration after a browser reload.
export function runMetadata(run) {
  const keys = [
    'id',
    'kind',
    'projectId',
    'chatId',
    'file',
    'files',
    'mode',
    'model',
    'effort',
    'status',
    'createdAt',
    'updatedAt',
    'maxSeconds',
    'liveEdits',
    'liveRevision',
    'liveUndone',
    'progress',
    'eventCursor',
    'usage',
  ]
  const value = Object.fromEntries(
    keys.filter((key) => run[key] !== undefined).map((key) => [key, run[key]]),
  )
  value.changeCount = run.changes?.length || 0
  value.liveChangeCount = run.liveChanges?.length || 0
  value.reasoningChars = run.reasoning?.length || 0
  value.reasoningSummaryChars = run.reasoningSummary?.length || 0
  value.logChars = run.log?.length || 0
  if (run.verification)
    value.verification = Object.fromEntries(
      ['compiled', 'complete', 'kernelChecked', 'reason']
        .filter((key) => run.verification[key] !== undefined)
        .map((key) => [key, run.verification[key]]),
    )
  return value
}
export function runTranscript(run) {
  return {
    ...runMetadata(run),
    prompt: run.prompt || '',
    message: run.message || '',
    messageBaseOffset: run.messageBaseOffset || 0,
    messageTruncated: !!run.messageTruncated,
    followups: run.followups || [],
    ...(run.error ? { error: run.error } : {}),
  }
}

export async function chatBrowserFixture({
  base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090',
  viewport = { width: 1600, height: 1000 },
  session,
  projects,
  files,
  chats,
  runs,
}) {
  const state = {
    session,
    projects,
    files,
    chats,
    runs,
    onMessage: null,
    onStop: null,
    onUndo: null,
    onCreateRun: null,
  }
  const report = {
    requests: [],
    unexpectedRequests: [],
    errors: [],
    sockets: [],
    checks: [],
  }
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport })
  page.on('pageerror', (error) =>
    report.errors.push(error.stack || error.message),
  )
  await page.addInitScript(
    ({ projectId, chatId }) => {
      if (!localStorage.getItem('lemex-project'))
        localStorage.setItem('lemex-project', projectId)
      if (!localStorage.getItem(`lemex-chat-${projectId}`))
        localStorage.setItem(`lemex-chat-${projectId}`, chatId)
      if (!localStorage.getItem(`lemex-file-${projectId}`))
        localStorage.setItem(`lemex-file-${projectId}`, 'Main.lean')
      localStorage.setItem('lemex-theme', 'dark')
      const sources = new Set()
      window.__chatFixture = {
        urls: [],
        connected(runId) {
          return [...sources].some((source) =>
            source.url.includes(`/api/runs/${runId}/events`),
          )
        },
        emit(runId, value) {
          for (const source of sources)
            if (source.url.includes(`/api/runs/${runId}/events`))
              source.dispatchEvent(
                new MessageEvent('message', { data: JSON.stringify(value) }),
              )
        },
      }
      class MockEventSource extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSED = 2
        constructor(url) {
          super()
          this.url = String(url)
          this.readyState = 0
          sources.add(this)
          window.__chatFixture.urls.push(this.url)
          queueMicrotask(() => {
            if (this.readyState === 2) return
            this.readyState = 1
            this.dispatchEvent(new Event('open'))
          })
        }
        close() {
          this.readyState = 2
          sources.delete(this)
        }
      }
      window.EventSource = MockEventSource
    },
    { projectId: projects[0].id, chatId: chats[0].id },
  )
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      endpoint = url.pathname,
      method = request.method()
    let body
    if (request.postData()) body = request.postDataJSON()
    report.requests.push({ method, endpoint, ...(body ? { body } : {}) })
    const respond = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      })
    if (method === 'GET') {
      if (endpoint === '/api/session') return respond(state.session)
      if (endpoint === '/api/projects') return respond(state.projects)
      for (const project of state.projects) {
        const prefix = `/api/projects/${project.id}`
        const sources = state.files[project.id]
        if (endpoint === prefix) return respond(project)
        if (endpoint === `${prefix}/files`)
          return respond(
            Object.entries(sources).map(([path, content]) => ({
              path,
              size: content.length,
            })),
          )
        if (endpoint === `${prefix}/file`) {
          const path = url.searchParams.get('path')
          if (path in sources)
            return respond({
              content: sources[path],
              hash: createHash('sha256').update(sources[path]).digest('hex'),
            })
        }
        if (endpoint === `${prefix}/git`)
          return respond({ branch: 'fixture', changes: [], repository: true })
        if (endpoint === `${prefix}/chats`)
          return respond(
            state.chats.filter((chat) => chat.projectId === project.id),
          )
        if (endpoint === `${prefix}/runs`)
          return respond(
            state.runs
              .filter((run) => run.projectId === project.id)
              .toReversed()
              .map((run) =>
                url.searchParams.get('summary') === '1'
                  ? runMetadata(run)
                  : run,
              ),
          )
      }
      const chat = state.chats.find(
        (chat) => endpoint === `/api/chats/${chat.id}`,
      )
      if (chat)
        return respond({
          chat,
          runs: state.runs
            .filter((run) => run.chatId === chat.id)
            .map(runTranscript),
        })
      const run = state.runs.find((run) => endpoint === `/api/runs/${run.id}`)
      if (run) return respond(run)
    }
    if (method === 'POST') {
      const project = state.projects.find(
        (project) => endpoint === `/api/projects/${project.id}/chats`,
      )
      if (project) {
        const chat = {
          id: `chat-new-${state.chats.length}`,
          projectId: project.id,
          title: 'New chat',
          updatedAt: '2026-10-13T13:00:00Z',
        }
        state.chats.unshift(chat)
        return respond(chat, 201)
      }
      const chat = state.chats.find(
        (chat) => endpoint === `/api/chats/${chat.id}/runs`,
      )
      if (chat && state.onCreateRun)
        return state.onCreateRun({ chat, body, respond })
      const target = state.runs.find((run) =>
        endpoint.startsWith(`/api/runs/${run.id}/`),
      )
      if (target && endpoint.endsWith('/messages') && state.onMessage)
        return state.onMessage({ run: target, body, respond })
      if (target && endpoint.endsWith('/stop') && state.onStop)
        return state.onStop({ run: target, body, respond })
      if (target && endpoint.endsWith('/undo') && state.onUndo)
        return state.onUndo({ run: target, body, respond })
    }
    report.unexpectedRequests.push({ method, endpoint })
    return respond({ error: 'Blocked by isolated chat browser fixture.' }, 409)
  })
  await page.routeWebSocket('**/websocket/**', (socket) => {
    report.sockets.push(socket.url())
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (!('id' in message)) return
      let result = null
      if (message.method === 'initialize')
        result = {
          capabilities: { textDocumentSync: 1 },
          serverInfo: { name: 'Browser fixture', version: '0.2.0' },
        }
      if (message.method === '$/lean/rpc/connect')
        result = { sessionId: 'fixture-session' }
      if (/plainGoal/.test(message.method || '')) result = { goals: [] }
      if (message.method === '$/lean/rpc/call') {
        if (message.params?.method === 'Lean.Widget.getInteractiveGoals')
          result = { goals: [] }
        if (message.params?.method === 'Lean.Widget.getInteractiveDiagnostics')
          result = []
        if (message.params?.method === 'Lean.Widget.getWidgets')
          result = { widgets: [] }
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  let sequence = Math.max(0, ...runs.map((run) => run.eventCursor || 0))
  const emit = async (run, type, data) => {
    if (typeof data === 'string') data = { text: data }
    const event = { seq: ++sequence, type, data }
    run.eventCursor = event.seq
    const field = {
      message: 'message',
      reasoning: 'reasoning',
      'reasoning-summary': 'reasoningSummary',
      activity: 'log',
    }[type]
    if (field)
      run[field] = (String(run[field] || '') + data.text).slice(-250000)
    if (type === 'status') run.status = data.status
    if (type === 'progress') run.progress = data
    if (type === 'followup') {
      run.followups ||= []
      const index = run.followups.findIndex((entry) => entry.id === data.id)
      if (index < 0) run.followups.push(data)
      else run.followups[index] = data
    }
    await page.evaluate(
      ({ runId, event }) => window.__chatFixture.emit(runId, event),
      { runId: run.id, event },
    )
    return event
  }
  const ready = async () => {
    await page.goto(base)
    await page.locator('.monaco-editor').waitFor({ timeout: 60000 })
    await page
      .locator('.editor-loading')
      .waitFor({ state: 'hidden', timeout: 60000 })
    await until(
      async () =>
        (await page.locator('.statusbar').innerText()).includes(
          'Lean connected',
        ),
      'mock Lean editor',
    )
  }
  const assertClean = () => {
    assert.equal(
      report.unexpectedRequests.length,
      0,
      JSON.stringify(report.unexpectedRequests),
    )
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors))
  }
  return { page, browser, state, report, emit, ready, assertClean }
}
