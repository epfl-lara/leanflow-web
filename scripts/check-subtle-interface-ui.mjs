#!/usr/bin/env node
// Closed visual fixture: no user projects, provider requests, or production service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import * as Y from 'yjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/subtle-interface-ui')
const baseline = process.env.SUBTLE_UI_BASELINE === '1'
const stage = baseline ? 'before' : 'after'
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const source = 'theorem identity (n : Nat) : n = n := by\n  rfl\n'
const doc = new Y.Doc()
doc.getText('source').insert(0, source)
const projectId = 'subtle-interface-project'
const checks = []
const metrics = {}
let fixture
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'fixture-owner', name: 'Interface fixture' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { available: true, revision: 'fixture' },
    },
    projects: [{ id: projectId, name: 'Collaborative proof', status: 'ready' }],
    files: {
      [projectId]: { 'Main.lean': source, 'Notes.md': '# Study notes\n' },
    },
    chats: [
      { id: 'interface-chat', projectId, title: 'Understanding identity' },
    ],
    runs: [
      {
        id: 'interface-run',
        projectId,
        chatId: 'interface-chat',
        mode: 'search',
        status: 'completed',
        createdAt: '2026-11-13T00:00:00Z',
        prompt: 'Explain the identity proof and suggest what to read next.',
        message:
          'The goal states that every natural number equals itself. The tactic `rfl` closes it by reflexivity.\n\nYou can keep editing the theorem while discussing it here.\n\n- Read the definition of equality.\n- Try the same proof for another type.',
        changes: [],
        verification: { kind: 'chat', complete: true },
        eventCursor: 0,
      },
    ],
  })
  const { page } = fixture
  await page.routeWebSocket('**/websocket/collaboration/**', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      if (request.type === 'open')
        socket.send(
          JSON.stringify({
            type: 'document',
            path: request.path,
            documentId: 'interface-document',
            update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
            content: source,
            hash: createHash('sha256').update(source).digest('hex'),
            openRequestId: request.requestId,
          }),
        )
    })
  })
  await fixture.ready()
  await page
    .getByText('Joining live editing…', { exact: true })
    .waitFor({ state: 'hidden' })
  const composer = page.getByLabel('Message Lemex', { exact: true })
  await composer.fill('Keep this unsent question while I adjust the view.')
  const geometry = async () =>
    page.evaluate(() => {
      const height = (selector) =>
        document.querySelector(selector)?.getBoundingClientRect().height
      const font = (selector) =>
        parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)
      return {
        header: height('.workbench-header'),
        fileToolbar: height('.file-toolbar'),
        toolsHeader: height('.tools-header'),
        chatPicker: height('.chat-picker-field select'),
        replyFont: font('.message-body'),
        sourceFont: font('.monaco-editor .view-lines'),
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        headerActions: [
          ...document.querySelectorAll(
            '.header-actions > .toolbar-action > .button',
          ),
        ].map((element) => ({
          label: element.textContent,
          height: element.getBoundingClientRect().height,
        })),
      }
    })
  const noOverflow = async () =>
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      'the page stays inside the viewport',
    )

  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width: 1600, height: 1000 })
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: `Use ${theme} theme`, exact: true })
        .click()
    await until(
      () =>
        page
          .locator('html')
          .getAttribute('data-theme')
          .then((value) => value === theme),
      'theme applied',
    )
    await noOverflow()
    metrics[`${theme}-desktop`] = await geometry()
    assert(
      metrics[`${theme}-desktop`].replyFont >= 14,
      'reply reading size stays readable',
    )
    assert(
      metrics[`${theme}-desktop`].sourceFont >= 14,
      'source text keeps its existing size',
    )
    if (!baseline) {
      assert(
        metrics[`${theme}-desktop`].header <= 88,
        'desktop header leaves more room for source',
      )
      assert(
        metrics[`${theme}-desktop`].fileToolbar <= 41,
        'file controls remain compact',
      )
      assert(
        metrics[`${theme}-desktop`].toolsHeader <= 45,
        'assistant header is compact',
      )
      assert(
        metrics[`${theme}-desktop`].chatPicker <= 31,
        'chat selection uses a compact control',
      )
    }
    await page.screenshot({
      path: path.join(output, `${stage}-${theme}-desktop.png`),
      fullPage: true,
    })
    checks.push(
      `${theme} desktop has contained controls and readable source/replies`,
    )

    await page.setViewportSize({ width: 390, height: 844 })
    await noOverflow()
    metrics[`${theme}-mobile`] = await geometry()
    assert(
      metrics[`${theme}-mobile`].headerActions.every(
        (action) => action.height >= 30,
      ),
      'mobile controls keep their touch height',
    )
    assert.equal(
      await composer.inputValue(),
      'Keep this unsent question while I adjust the view.',
    )
    await page.screenshot({
      path: path.join(output, `${stage}-${theme}-mobile-chat.png`),
      fullPage: true,
    })
    await page
      .getByRole('button', { name: 'Close tools panel', exact: true })
      .click()
    await noOverflow()
    await page.screenshot({
      path: path.join(output, `${stage}-${theme}-mobile-editor.png`),
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Lemex', exact: true }).click()
    await composer.waitFor({ state: 'visible' })
    checks.push(
      `${theme} narrow layout keeps controls, draft and editor/chat navigation usable`,
    )
  }
  if (
    !baseline &&
    (await fs.stat(path.join(output, 'before.json')).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false
        throw error
      },
    ))
  ) {
    const previous = JSON.parse(
      await fs.readFile(path.join(output, 'before.json'), 'utf8'),
    )
    for (const theme of ['dark', 'light']) {
      const before = previous.metrics[`${theme}-desktop`]
      const after = metrics[`${theme}-desktop`]
      assert(
        after.header + after.fileToolbar < before.header + before.fileToolbar,
        'compact desktop chrome yields more source height',
      )
      assert(
        after.toolsHeader + after.chatPicker <
          before.toolsHeader + before.chatPicker,
        'compact assistant controls yield more conversation height',
      )
      for (const action of metrics[`${theme}-mobile`].headerActions) {
        const original = previous.metrics[`${theme}-mobile`].headerActions.find(
          (item) => item.label === action.label,
        )
        if (original)
          assert(
            action.height >= original.height - 0.5,
            'mobile controls do not shrink',
          )
      }
    }
    checks.push(
      'desktop chrome takes less space while mobile target heights stay unchanged',
    )
  }
  fixture.assertClean()
  await fs.writeFile(
    path.join(output, `${stage}.json`),
    JSON.stringify({ passed: true, checks, metrics }, null, 2) + '\n',
  )
  console.log(JSON.stringify({ passed: true, checks, metrics }))
} catch (error) {
  await fs.writeFile(
    path.join(output, `${stage}.json`),
    JSON.stringify(
      { passed: false, checks, metrics, error: error.stack },
      null,
      2,
    ) + '\n',
  )
  throw error
} finally {
  await fixture?.browser.close()
  doc.destroy()
  await new Promise((resolve) => server.close(resolve))
}
