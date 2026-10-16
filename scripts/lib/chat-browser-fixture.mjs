// Isolate chat/browser regressions from real workspaces, provider calls, and Lean.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'
import {
  reasoningBlocksFromEvents,
  recordReasoningBlock,
} from '../../shared/reasoning-timeline.mjs'

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
    'currentFile',
    'files',
    'proofTarget',
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
  if (value.proofTarget) {
    const { source: _source, ...location } = value.proofTarget
    value.proofTarget = location
  }
  value.changeCount = run.changes?.length ?? run.changeCount ?? 0
  value.liveChangeCount = run.liveChanges?.length ?? run.liveChangeCount ?? 0
  value.changePaths =
    run.changes?.map((change) => change.path) ?? run.changePaths ?? []
  value.liveChangePaths =
    run.liveChanges?.map((change) => change.path) ?? run.liveChangePaths ?? []
  value.reasoningChars = run.reasoning?.length || 0
  value.reasoningSummaryChars = run.reasoningSummary?.length || 0
  value.logChars = run.log?.length || 0
  if (run.verification)
    value.verification = Object.fromEntries(
      ['kind', 'compiled', 'complete', 'kernelChecked', 'reason']
        .filter((key) => run.verification[key] !== undefined)
        .map((key) => [key, run.verification[key]]),
    )
  return value
}
export function runReceipt(run) {
  const {
    changes: _changes,
    liveChanges: _liveChanges,
    snapshot: _snapshot,
    verificationRoot: _verificationRoot,
    followupContexts: _followupContexts,
    owner: _owner,
    ...value
  } = run
  const {
    changeCount,
    liveChangeCount,
    changePaths,
    liveChangePaths,
    proofTarget,
  } = runMetadata(run)
  return {
    ...value,
    changeCount,
    liveChangeCount,
    changePaths,
    liveChangePaths,
    ...(proofTarget ? { proofTarget } : {}),
  }
}
export function runTranscript(run) {
  return {
    ...runMetadata(run),
    prompt: run.prompt || '',
    message: run.message || '',
    messageBaseOffset: run.messageBaseOffset || 0,
    messageTruncated: !!run.messageTruncated,
    followups: run.followups || [],
    reasoningBlocks: run.reasoningBlocks || [],
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
  documentSymbols = [],
  definitionLocations = null,
  legacyReasoning = false,
  failReasoningHistory = false,
  launchOptions = {},
}) {
  for (const run of runs)
    run.reasoningBlocks ??= reasoningBlocksFromEvents(
      run.events || [
        { seq: 0, type: 'reasoning', data: { text: run.reasoning || '' } },
        {
          seq: 1,
          type: 'reasoning-summary',
          data: { text: run.reasoningSummary || '' },
        },
        { seq: 2, type: 'message', data: { text: run.message || '' } },
      ],
    )
  const state = {
    session,
    projects,
    files,
    chats,
    runs,
    documentSymbols,
    definitionLocations,
    onMessage: null,
    onStop: null,
    onUndo: null,
    onCreateRun: null,
    onCreateChat: null,
    onLeanMessage: null,
  }
  const report = {
    requests: [],
    unexpectedRequests: [],
    errors: [],
    sockets: [],
    checks: [],
  }
  const browser = await chromium.launch({ headless: true, ...launchOptions })
  const page = await browser.newPage({ viewport })
  page.on('pageerror', (error) =>
    report.errors.push(error.stack || error.message),
  )
  await page.addInitScript(
    ({ projectId, chatId, failReasoningHistory }) => {
      // Fixtures belong to the app, not browser-managed PDF/infoview frames.
      if (window !== window.top) return
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
        disconnect(runId) {
          for (const source of [...sources]) {
            if (source.url.includes(`/api/runs/${runId}/events`)) {
              source.close()
              source.dispatchEvent(new Event('error'))
            }
          }
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
            if (
              failReasoningHistory &&
              new URL(this.url, location.href).searchParams.get('after') === '0'
            ) {
              this.dispatchEvent(new Event('error'))
              return
            }
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
    { projectId: projects[0].id, chatId: chats[0].id, failReasoningHistory },
  )
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      endpoint = url.pathname,
      method = request.method()
    let body
    if (request.postData()) body = request.postDataJSON()
    report.requests.push({
      method,
      endpoint,
      ...(url.searchParams.has('view')
        ? { view: url.searchParams.get('view') }
        : {}),
      ...(body ? { body } : {}),
    })
    const respond = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      })
    if (method === 'GET') {
      if (endpoint === '/api/session') return respond(state.session)
      if (endpoint === '/api/git-connections')
        return respond({ connections: [], identity: { name: '', email: '' } })
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
        if (endpoint === `${prefix}/folders`) {
          const folders = new Set()
          for (const filename of Object.keys(sources)) {
            if (filename.startsWith('.lake/')) continue
            const segments = filename.split('/')
            segments.pop()
            for (let index = 1; index <= segments.length; index++)
              folders.add(segments.slice(0, index).join('/'))
          }
          return respond([...folders].sort())
        }
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
        if (endpoint === `${prefix}/checks`) return respond([])
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
            .map((run) => {
              const transcript = runTranscript(run)
              if (legacyReasoning) delete transcript.reasoningBlocks
              return transcript
            }),
        })
      const run = state.runs.find((run) => endpoint === `/api/runs/${run.id}`)
      if (run) {
        const snapshot =
          url.searchParams.get('view') === 'metadata' ? runReceipt(run) : run
        return respond(
          legacyReasoning
            ? Object.fromEntries(
                Object.entries(snapshot).filter(
                  ([key]) => key !== 'reasoningBlocks',
                ),
              )
            : snapshot,
        )
      }
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
        if (state.onCreateChat) return state.onCreateChat({ chat, respond })
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
  const leanSockets = []
  await page.routeWebSocket('**/websocket/**', (socket) => {
    leanSockets.push(socket)
    report.sockets.push(socket.url())
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      state.onLeanMessage?.(message, socket.url(), socket)
      if (!('id' in message)) return
      let result = null
      if (message.method === 'initialize')
        result = {
          capabilities: {
            textDocumentSync: 1,
            ...(state.definitionLocations ? { definitionProvider: true } : {}),
          },
          serverInfo: { name: 'Browser fixture', version: '0.2.0' },
        }
      if (message.method === '$/lean/rpc/connect')
        result = { sessionId: 'fixture-session' }
      if (/plainGoal/.test(message.method || '')) result = { goals: [] }
      if (message.method === 'textDocument/documentSymbol')
        result = state.documentSymbols
      if (message.method === 'textDocument/definition') {
        result = state.definitionLocations || []
        report.requests.push({
          method: 'LSP',
          endpoint: 'textDocument/definition',
          body: message.params,
        })
      }
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
      run.reasoningBlocks = recordReasoningBlock(
        run.reasoningBlocks || [],
        field,
        data.text.length,
        {
          message: (run.messageBaseOffset || 0) + (run.message?.length || 0),
          followups: run.followups?.length || 0,
          reasoning:
            (run.reasoningBaseOffset || 0) + (run.reasoning?.length || 0),
          reasoningSummary:
            (run.reasoningSummaryBaseOffset || 0) +
            (run.reasoningSummary?.length || 0),
        },
        `reasoning-${event.seq}`,
      )
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
  const closeLean = (options) =>
    Promise.all(leanSockets.map((socket) => socket.close(options)))
  const sendLean = (message) => {
    leanSockets.at(-1)?.send(JSON.stringify(message))
  }
  return {
    page,
    browser,
    state,
    report,
    emit,
    ready,
    assertClean,
    closeLean,
    sendLean,
  }
}
