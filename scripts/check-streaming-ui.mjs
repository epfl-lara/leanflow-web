#!/usr/bin/env node
// Browser-only regression fixture. Every API, EventSource, and Lean WebSocket
// interaction is mocked; this never starts providers or writes project files.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'
import {
  runMetadata,
  runReceipt,
  runTranscript,
} from './lib/chat-browser-fixture.mjs'
import {
  reasoningBlocksFromEvents,
  recordReasoningBlock,
} from '../shared/reasoning-timeline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const reportDir = path.join(root, '.runtime/streaming-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'streaming-ui-fixture'
const chatId = 'streaming-chat'
const activeId = 'streaming-run'
const earlierId = 'earlier-run'
const project = {
  id: projectId,
  name: 'Streaming UI fixture',
  status: 'ready',
  toolchain: 'leanprover/lean4:v4.34.1',
}
const files = {
  'Main.lean': 'import Lean\n\nexample (a : Nat) : a = a := by\n  rfl\n',
  'Notes.lean': 'import Lean\n\nexample : True := by\n  trivial\n',
}
const session = {
  user: { id: 'fixture-owner', name: 'Fixture owner' },
  templates: [],
  models: [{ id: 'fixture-model', name: 'Streaming fixture model' }],
  defaultModel: 'fixture-model',
  runtime: { ready: true },
  lemex: { revision: 'fixture', available: true },
}
const chats = [
  {
    id: chatId,
    title: 'Streaming navigation',
    updatedAt: '2026-10-13T09:00:00Z',
  },
]
const paragraph = (index) =>
  `Paragraph ${index}. Read this earlier explanation while Lemex continues working. The theorem statement remains the reference, and this paragraph should stay still when new output arrives.\n\n`
const earlier = {
  id: earlierId,
  projectId,
  chatId,
  mode: 'search',
  status: 'completed',
  createdAt: '2026-10-13T08:00:00Z',
  prompt: 'Explain the earlier proof.',
  message: Array.from({ length: 24 }, (_, index) => paragraph(index)).join(''),
  events: [],
  verification: { kind: 'search', reason: 'No project files changed.' },
}
let sequence = 0
const event = (type, text) => ({ seq: ++sequence, type, data: { text } })
const current = {
  id: activeId,
  projectId,
  chatId,
  mode: 'repair',
  status: 'running',
  createdAt: '2026-10-13T09:00:00Z',
  prompt:
    'Keep working while I inspect earlier output and prepare my next request.',
  files: ['Main.lean'],
  maxSeconds: null,
  liveEdits: false,
  events: [
    event(
      'message',
      Array.from({ length: 18 }, (_, index) => paragraph(index + 24)).join(''),
    ),
    event(
      'reasoning',
      'REASONING_FIXTURE_BODY\n\n' +
        'Exposed reasoning for browser testing only.\n\n'.repeat(3600),
    ),
    ...Array.from({ length: 140 }, (_, index) =>
      event(
        'activity',
        `ACTIVITY_FIXTURE_BODY ${index}: ` +
          'A tool reports progress. '.repeat(24),
      ),
    ),
  ],
}
current.message = current.events
  .filter((item) => item.type === 'message')
  .map((item) => item.data.text)
  .join('')
current.reasoning = current.events
  .filter((item) => item.type === 'reasoning')
  .map((item) => item.data.text)
  .join('')
current.reasoningSummary = 'The model is checking the current proof.'
current.log = current.events
  .filter((item) => item.type === 'activity')
  .map((item) => item.data.text)
  .join('\n')
current.eventCursor = sequence
current.reasoningBlocks = reasoningBlocksFromEvents(current.events)
delete current.events
const runs = new Map([
  [earlierId, earlier],
  [activeId, current],
])
let holdNextSnapshotFor = null,
  heldSnapshot,
  releaseHeldSnapshot,
  holdStopResponse = false,
  releaseStopResponse
const report = {
  projectId,
  mockedRequests: [],
  unexpectedRequests: [],
  mockSockets: [],
  errors: [],
  checks: [],
  scrollSamples: [],
}
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('pageerror', (error) =>
  report.errors.push(error.stack || error.message),
)
await page.addInitScript(
  ({ projectId, chatId }) => {
    localStorage.setItem('lemex-project', projectId)
    localStorage.setItem(`lemex-chat-${projectId}`, chatId)
    localStorage.setItem(`lemex-file-${projectId}`, 'Main.lean')
    localStorage.setItem('lemex-theme', 'dark')
    const sources = new Set()
    window.__streamingFixture = {
      urls: [],
      emit(runId, value) {
        for (const source of sources) {
          if (source.url.includes(`/api/runs/${runId}/events`))
            source.dispatchEvent(
              new MessageEvent('message', { data: JSON.stringify(value) }),
            )
        }
      },
      connected(runId) {
        return [...sources].some((source) =>
          source.url.includes(`/api/runs/${runId}/events`),
        )
      },
    }
    class FixtureEventSource extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 2
      constructor(url) {
        super()
        this.url = String(url)
        this.readyState = 0
        window.__streamingFixture.urls.push(this.url)
        sources.add(this)
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
    window.EventSource = FixtureEventSource
  },
  { projectId, chatId },
)
await page.route('**/api/**', async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    endpoint = url.pathname,
    method = request.method()
  report.mockedRequests.push({
    method,
    endpoint,
    ...(url.searchParams.has('view')
      ? { view: url.searchParams.get('view') }
      : {}),
  })
  const json = (value, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    })
  if (method === 'GET') {
    if (endpoint === '/api/session') return json(session)
    if (endpoint === '/api/projects') return json([project])
    if (endpoint === `/api/projects/${projectId}`) return json(project)
    if (endpoint === `/api/projects/${projectId}/files`)
      return json(
        Object.entries(files).map(([path, content]) => ({
          path,
          size: content.length,
        })),
      )
    if (endpoint === `/api/projects/${projectId}/folders`) return json([])
    if (endpoint === `/api/projects/${projectId}/checks`) return json([])
    if (endpoint === `/api/projects/${projectId}/git`)
      return json({ branch: 'fixture', changes: [], repository: true })
    if (endpoint === `/api/projects/${projectId}/file`) {
      const filename = url.searchParams.get('path')
      if (filename in files)
        return json({
          content: files[filename],
          hash: createHash('sha256').update(files[filename]).digest('hex'),
        })
    }
    if (endpoint === `/api/projects/${projectId}/chats`) return json(chats)
    if (endpoint === `/api/projects/${projectId}/runs`)
      return json(
        [...runs.values()]
          .reverse()
          .map((run) =>
            url.searchParams.get('summary') === '1' ? runMetadata(run) : run,
          ),
      )
    const selectedChat = chats.find(
      (chat) => endpoint === `/api/chats/${chat.id}`,
    )
    if (selectedChat)
      return json({
        chat: selectedChat,
        runs: [...runs.values()]
          .filter((run) => run.chatId === selectedChat.id)
          .map(runTranscript),
      })
    const selectedRun = [...runs.values()].find(
      (run) => endpoint === `/api/runs/${run.id}`,
    )
    if (selectedRun) {
      const snapshot =
        url.searchParams.get('view') === 'metadata'
          ? runReceipt(selectedRun)
          : selectedRun
      if (holdNextSnapshotFor === selectedRun.id) {
        holdNextSnapshotFor = null
        heldSnapshot = structuredClone(snapshot)
        return new Promise((resolve) => {
          releaseHeldSnapshot = () => json(heldSnapshot).then(resolve)
        })
      }
      return json(snapshot)
    }
  }
  if (method === 'POST' && endpoint === `/api/projects/${projectId}/chats`) {
    const chat = {
      id: `new-chat-${chats.length}`,
      title: 'New chat',
      updatedAt: '2026-10-13T10:00:00Z',
    }
    chats.unshift(chat)
    return json(chat)
  }
  if (method === 'POST' && endpoint === `/api/runs/${activeId}/stop`) {
    current.status = 'cancelled'
    current.eventCursor = ++sequence
    current.liveEdits = true
    current.liveRevision = 1
    const before = files['Notes.lean']
    files['Notes.lean'] =
      'import Lean\n\n-- FINAL_STOP_EDIT_FIXTURE\nexample : 1 + 1 = 2 := by\n  decide\n'
    current.liveChanges = [
      {
        path: 'Notes.lean',
        before,
        after: files['Notes.lean'],
        beforeHash: createHash('sha256').update(before).digest('hex'),
      },
    ]
    if (holdStopResponse) {
      const stopped = structuredClone(current)
      return new Promise((resolve) => {
        releaseStopResponse = () => json(stopped).then(resolve)
      })
    }
    return json(current)
  }
  report.unexpectedRequests.push({ method, endpoint })
  return json(
    { error: 'Request blocked by the isolated browser fixture.' },
    409,
  )
})
await page.routeWebSocket('**/websocket/**', (socket) => {
  report.mockSockets.push(socket.url())
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
    if (message.method === '$/lean/rpc/call') {
      if (message.params?.method === 'Lean.Widget.getInteractiveGoals')
        result = { goals: [] }
      if (message.params?.method === 'Lean.Widget.getInteractiveDiagnostics')
        result = []
      if (message.params?.method === 'Lean.Widget.getWidgets')
        result = { widgets: [] }
    }
    if (/plainGoal/.test(message.method || '')) result = { goals: [] }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
})
const sleep = (duration) =>
  new Promise((resolve) => setTimeout(resolve, duration))
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function burst(count = 5) {
  for (let index = 0; index < count; index++) {
    const values = [
      event('message', paragraph(sequence).repeat(12)),
      event('reasoning', `Further reasoning ${sequence}.\n\n`.repeat(25)),
      event('activity', `Later activity ${sequence}.`.repeat(40)),
    ]
    for (const value of values) {
      const field = { message: 'message', reasoning: 'reasoning' }[value.type]
      if (field)
        current.reasoningBlocks = recordReasoningBlock(
          current.reasoningBlocks,
          field,
          value.data.text.length,
          {
            message:
              current.message.length +
              (field === 'reasoning' ? values[0].data.text.length : 0),
            reasoning: current.reasoning.length,
            reasoningSummary: current.reasoningSummary.length,
          },
          `reasoning-${value.seq}`,
        )
    }
    current.message += values[0].data.text
    current.reasoning += values[1].data.text
    current.log += '\n' + values[2].data.text
    current.eventCursor = values.at(-1).seq
    await page.evaluate(
      ({ activeId, values }) =>
        values.forEach((value) =>
          window.__streamingFixture.emit(activeId, value),
        ),
      { activeId, values },
    )
    await sleep(60)
  }
  await sleep(200)
}
const conversation = page.locator('.assistant-conversation')
const geometry = () =>
  conversation.evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    client: element.clientHeight,
    pageX: window.scrollX,
    pageY: window.scrollY,
    body: document.documentElement.scrollHeight,
    viewport: innerHeight,
  }))
async function inViewport(locator, label) {
  assert(await locator.isVisible(), `${label} is hidden`)
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  assert(
    box &&
      box.x >= 0 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y >= 0 &&
      box.y + box.height <= viewport.height + 1,
    `${label} is outside the visible panel`,
  )
}
try {
  await page.goto(base)
  await page.locator('.monaco-editor').waitFor({ timeout: 60000 })
  await page
    .locator('.editor-loading')
    .waitFor({ state: 'hidden', timeout: 60000 })
  await until(
    async () =>
      (await page.locator('.statusbar').innerText()).includes('Lean connected'),
    'mock Lean connection',
  )
  await until(
    () =>
      page.evaluate(
        (activeId) => window.__streamingFixture.connected(activeId),
        activeId,
      ),
    'active mocked EventSource',
  )
  report.initialEventSource = await page.evaluate(
    () => window.__streamingFixture.urls[0],
  )
  assert.equal(
    Number(new URL(report.initialEventSource, base).searchParams.get('after')),
    current.eventCursor,
    'SSE must resume after the accumulated snapshot cursor',
  )
  await conversation.waitFor()
  await until(
    async () => (await geometry()).height > (await geometry()).client + 800,
    'long conversation scroll area',
  )

  const activeTurn = page.locator(`[data-run-id="${activeId}"]`)
  const activeGets = () =>
    report.mockedRequests.filter(
      (request) =>
        request.method === 'GET' &&
        request.endpoint === `/api/runs/${activeId}`,
    )
  assert(activeGets().some((request) => request.view === 'metadata'))
  assert(
    activeGets().every((request) => request.view === 'metadata'),
    'Background recovery must not request full proof previews',
  )
  await activeTurn.locator('.turn-details > summary').click()
  await until(
    async () => activeGets().some((request) => request.view !== 'metadata'),
    'explicit Details to load the full run',
  )
  report.checks.push(
    'Background recovery requests metadata; explicit Details loads the full run',
  )
  const reasoning = activeTurn.locator('.reasoning-trace').first(),
    activity = activeTurn.locator('.activity-log')
  assert.equal(
    await reasoning.getAttribute('open'),
    null,
    'Reasoning should begin collapsed while working',
  )
  assert.equal(
    await activity.getAttribute('open'),
    null,
    'Activity should begin collapsed while working',
  )
  assert.equal(
    await page.locator('.reasoning-content').count(),
    0,
    'Collapsed reasoning should not mount its large body',
  )
  assert(
    !(await activity.textContent()).includes('ACTIVITY_FIXTURE_BODY'),
    'Collapsed activity should not mount its event rows',
  )
  report.checks.push(
    'Large reasoning and activity bodies are absent while collapsed',
  )
  await activeTurn.locator('.turn-details > summary').click()

  await page.setViewportSize({ width: 1366, height: 768 })
  await until(
    async () => (await geometry()).client >= 200,
    'at least 200px of conversation at laptop height',
  )
  await inViewport(
    page.getByRole('button', { name: 'Stop', exact: true }),
    'Stop at laptop height',
  )
  await inViewport(
    page.getByLabel('Message Lemex'),
    'Composer at laptop height',
  )
  await inViewport(
    page.getByRole('button', { name: 'New chat', exact: true }),
    'New chat at laptop height',
  )
  report.laptopGeometry = await geometry()
  assert.equal(report.laptopGeometry.pageY, 0, 'Laptop panel scrolled the page')
  assert(report.laptopGeometry.body <= 769, 'Laptop panel expanded the page')
  await page.screenshot({
    path: path.join(reportDir, 'laptop-working.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await sleep(250)
  report.checks.push(
    'Laptop layout keeps at least 200px for conversation with Stop, new chat, and composer visible',
  )

  await conversation.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await sleep(300)
  const box = await conversation.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -650)
  await sleep(250)
  const reading = await geometry()
  assert(
    reading.top < reading.height - reading.client - 300,
    'Manual wheel did not move away from latest output',
  )
  await burst(9)
  const held = await geometry()
  assert(
    Math.abs(held.top - reading.top) <= 3,
    `Streaming moved the reading position from ${reading.top} to ${held.top}`,
  )
  assert.equal(held.pageY, 0, 'Streaming scrolled the document')
  assert.equal(held.pageX, 0, 'Streaming moved the page horizontally')
  assert(
    held.body <= held.viewport + 1,
    'Conversation expanded the page instead of using its inner scroll area',
  )
  report.scrollSamples.push({
    label: 'manual reading during nine bursts',
    before: reading,
    after: held,
  })
  report.checks.push(
    'Manual scroll stays fixed through new assistant, reasoning, and activity output',
  )

  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true })
  await inViewport(jump, 'Jump to latest')
  await jump.click()
  await burst(5)
  await until(async () => {
    const value = await geometry()
    return value.height - value.client - value.top < 12
  }, 'resumed following after Jump to latest')
  report.scrollSamples.push({
    label: 'following resumed',
    ...(await geometry()),
  })
  report.checks.push('Jump to latest explicitly resumes following')

  await activeTurn.locator('.turn-details > summary').click()
  await reasoning.locator('summary').click()
  await until(
    async () => (await page.locator('.reasoning-content').count()) === 1,
    'expanded reasoning content',
  )
  await burst(3)
  assert.notEqual(
    await reasoning.getAttribute('open'),
    null,
    'Streaming closed the reasoning chosen by the user',
  )
  await reasoning.locator('summary').click()
  await burst(3)
  assert.equal(
    await reasoning.getAttribute('open'),
    null,
    'Streaming reopened collapsed reasoning',
  )
  assert.equal(await page.locator('.reasoning-content').count(), 0)
  await activity.locator('summary').click()
  await burst(3)
  assert.notEqual(
    await activity.getAttribute('open'),
    null,
    'Streaming closed the activity chosen by the user',
  )
  assert(
    (await activity.textContent()).includes('ACTIVITY_FIXTURE_BODY'),
    'Expanded activity rows are absent',
  )
  await activity.locator('summary').click()
  await burst(3)
  assert.equal(
    await activity.getAttribute('open'),
    null,
    'Streaming reopened collapsed activity',
  )
  assert(
    !(await activity.textContent()).includes('ACTIVITY_FIXTURE_BODY'),
    'Collapsed activity should unmount its event rows',
  )
  report.checks.push(
    'User detail choices persist through streaming and closed bodies unmount',
  )
  await activeTurn.locator('.turn-details > summary').click()

  const composer = page.getByLabel('Message Lemex')
  assert(
    await composer.isEditable(),
    'Draft composer is locked while the agent works',
  )
  await composer.fill(
    'A draft for the next turn, while the current proof keeps running.',
  )
  await burst(3)
  assert.equal(
    await composer.inputValue(),
    'A draft for the next turn, while the current proof keeps running.',
  )
  assert(
    await page
      .getByRole('button', { name: 'Send update', exact: true })
      .isEnabled(),
    'Guidance should remain available for the active task',
  )
  assert.equal(
    report.mockedRequests.filter(
      (request) =>
        request.method === 'POST' && request.endpoint.endsWith('/runs'),
    ).length,
    0,
    'Typing while active must not create a concurrent run',
  )
  await inViewport(
    page.getByRole('button', { name: 'Stop', exact: true }),
    'Stop',
  )
  await inViewport(
    page.getByRole('button', { name: 'New chat', exact: true }),
    'New chat',
  )
  assert.equal(
    await page.getByLabel('Assistant history').count(),
    0,
    'History belongs in the continuous transcript',
  )
  await inViewport(composer, 'Draft composer')
  report.checks.push(
    'Draft remains editable, guidance is available, and key controls stay visible',
  )

  await page.locator('.file-item[title="Notes.lean"]').click()
  await until(
    async () =>
      (await page.locator('.composer-context').innerText()).includes(
        'Notes.lean',
      ),
    'file navigation during streaming',
  )
  await burst(3)
  const earlierTurn = page.locator(`[data-run-id="${earlierId}"]`)
  await earlierTurn.locator('.turn-details > summary').click()
  assert(
    (await conversation.innerText()).includes('Explain the earlier proof.'),
  )
  await burst(3)
  await earlierTurn.locator('.turn-details > summary').click()
  assert.equal(current.status, 'running')
  await until(
    () =>
      page.evaluate(
        (activeId) => window.__streamingFixture.connected(activeId),
        activeId,
      ),
    'return to running turn',
  )
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await until(
    async () => (await page.getByLabel('Select chat').inputValue()) !== chatId,
    'new chat while task continues',
  )
  await composer.fill('A separate chat draft.')
  assert(await composer.isEditable())
  assert(
    await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(),
  )
  await page.getByLabel('Select chat').selectOption(chatId)
  await until(
    () =>
      page.evaluate(
        (activeId) => window.__streamingFixture.connected(activeId),
        activeId,
      ),
    'return to original chat',
  )
  report.checks.push(
    'Files, previous turns, new chat, and original chat remain navigable during work',
  )
  await page.screenshot({
    path: path.join(reportDir, 'working-and-navigable.png'),
    fullPage: true,
  })
  holdStopResponse = true
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await until(async () => !!releaseStopResponse, 'held Stop response')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await until(
    async () => (await page.getByLabel('Select chat').inputValue()) !== chatId,
    'navigate before Stop responds',
  )
  const afterStopChatId = await page.getByLabel('Select chat').inputValue()
  await until(
    async () => (await conversation.locator('[data-run-id]').count()) === 0,
    'empty new chat before Stop response',
  )
  await releaseStopResponse()
  await until(
    async () =>
      current.status === 'cancelled' &&
      !(await page.getByRole('button', { name: 'Stop', exact: true }).count()),
    'Stop request to finish',
  )
  assert.equal(
    await page.getByLabel('Select chat').inputValue(),
    afterStopChatId,
    'Late Stop response switched chats',
  )
  assert.equal(
    await conversation.locator('[data-run-id]').count(),
    0,
    'Late Stop response replaced the new chat with the old run',
  )
  assert.equal(
    await page.locator('.run-status').count(),
    0,
    'Late Stop response rendered the old run in the new chat',
  )
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes(
        'FINAL_STOP_EDIT_FIXTURE',
      ),
    'final live file write after Stop while another chat is visible',
  )
  assert.equal(
    report.mockedRequests.filter(
      (request) =>
        request.method === 'POST' && request.endpoint.endsWith('/stop'),
    ).length,
    1,
  )
  report.checks.push(
    'Delayed Stop leaves the new chat selected and refreshes its final live file write',
  )

  const raceId = 'terminal-race-run'
  const race = {
    id: raceId,
    projectId,
    chatId,
    status: 'running',
    mode: 'search',
    createdAt: '2026-10-13T11:00:00Z',
    prompt: 'Exercise a delayed running snapshot arriving after completion.',
    message: 'The last task is still working.',
    reasoning: '',
    log: '',
    eventCursor: ++sequence,
  }
  runs.set(raceId, race)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await until(
    async () => (await page.getByLabel('Select chat').inputValue()) !== chatId,
    'switch before terminal-race fixture',
  )
  await page.getByLabel('Select chat').selectOption(chatId)
  await until(
    () =>
      page.evaluate(
        (raceId) => window.__streamingFixture.connected(raceId),
        raceId,
      ),
    'terminal-race EventSource',
  )
  holdNextSnapshotFor = raceId
  await until(
    async () => !!releaseHeldSnapshot,
    'a running poll captured before completion',
    12000,
  )
  race.status = 'completed'
  race.message = 'TERMINAL_RESULT_FIXTURE: The task completed successfully.'
  race.verification = { kind: 'search', reason: 'No project files changed.' }
  const terminalEvent = {
    seq: ++sequence,
    type: 'status',
    data: { status: 'completed' },
  }
  race.eventCursor = terminalEvent.seq
  await page.evaluate(
    ({ raceId, terminalEvent }) =>
      window.__streamingFixture.emit(raceId, terminalEvent),
    { raceId, terminalEvent },
  )
  await until(
    async () =>
      (await conversation.innerText()).includes('TERMINAL_RESULT_FIXTURE'),
    'completed snapshot to replace active output',
  )
  await releaseHeldSnapshot()
  await sleep(600)
  assert.equal(
    await page.getByRole('button', { name: 'Stop', exact: true }).count(),
    0,
    'Stale running poll resurrected a completed task',
  )
  assert(
    (await conversation.innerText()).includes('TERMINAL_RESULT_FIXTURE'),
    'Stale poll replaced the final result',
  )
  report.checks.push(
    'A delayed running snapshot cannot replace a newer completed result or restart activity',
  )
  report.eventSourceUrls = await page.evaluate(
    () => window.__streamingFixture.urls,
  )
  assert.equal(
    report.unexpectedRequests.length,
    0,
    JSON.stringify(report.unexpectedRequests),
  )
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors))
  report.passed = true
  console.log(
    'PASS: streaming preserves reading position, explicit follow, lazy user-controlled details, editable drafts, and working navigation/Stop; all backends mocked',
  )
} catch (error) {
  report.passed = false
  report.failure = error.stack || error.message
  await page
    .screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
