#!/usr/bin/env node
// A directly mounted assistant catches first-render chat restoration races.
// All requests are mocked; no real project, save, provider call, or run is used.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8102'
const projectId = 'focus-recovery-project',
  userId = 'focus-recovery-owner'
const target = {
  path: 'Main.lean',
  startLine: 3,
  endLine: 4,
  name: 'second',
  source: 'theorem second : True := by\n  trivial',
}
const props = {
  projectId,
  file: 'Main.lean',
  files: [{ path: 'Main.lean', size: 100 }],
  session: {
    user: { id: userId, name: 'Fixture' },
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
  },
  dirty: false,
  readOnly: false,
  focusRequest: { id: 1, projectId, target, mode: 'proofs' },
}
const fixture = await chatBrowserFixture({
  base,
  session: props.session,
  projects: [
    { id: projectId, name: 'Focus recovery fixture', status: 'ready' },
  ],
  files: { [projectId]: { 'Main.lean': target.source } },
  chats: [
    { id: 'old-chat', projectId, title: 'Saved conversation', runCount: 0 },
    { id: 'other-chat', projectId, title: 'Other conversation', runCount: 0 },
  ],
  runs: [],
})
const { page, browser, report } = fixture
const reportDir = path.resolve('.runtime/proof-focus-recovery-ui')
await fs.mkdir(reportDir, { recursive: true })
const results = { checks: [], providerCalls: 0 }
const harness = `<!doctype html><html><head><link rel="stylesheet" href="/__focus-recovery.css"></head><body><div id="root"></div><script type="module" src="/__focus-recovery.js"></script></body></html>`
const harnessSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantPanel } from './src/studio/AssistantPanel.tsx';
import './src/studio/studio.css';
const props=${JSON.stringify(props)};
if(sessionStorage.getItem('focus-recovery-attached')) props.focusRequest=null;
Object.assign(props,{onDeleteChat:()=>{},beforeRun:async()=>{},beforeApply:async()=>{},onDiscard:async()=>{},onApplied:async()=>{},onFilesUpdated:async()=>{},onOpenTarget:()=>{},onFocusHandled:()=>{sessionStorage.setItem('focus-recovery-attached','1');window.__focusRecoveryRender({focusRequest:null})}});
window.__focusRecoveryProps=props;
const root=createRoot(document.getElementById('root'));
window.__focusRecoveryRender=(extra)=>{Object.assign(props,extra);root.render(React.createElement(AssistantPanel,props))};
window.__focusRecoveryRender({});`
await page.addInitScript(
  ({ key }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, 'old-chat')
  },
  {
    key: `lemex-chat:${userId}:${projectId}`,
  },
)
await page.route(`${base}/__focus-recovery`, (route) =>
  route.fulfill({ contentType: 'text/html', body: harness }),
)
let releaseChats
const chatsGate = new Promise((resolve) => {
  releaseChats = resolve
})
await page.route(`**/api/projects/${projectId}/chats`, async (route) => {
  await chatsGate
  await route.fallback()
})
try {
  // This first-mount race needs an isolated component. Bundle it in memory so
  // the fixture also works with the static CI server, without Vite dev URLs.
  const compiled = await build({
    stdin: {
      contents: harnessSource,
      resolveDir: path.resolve('client'),
      loader: 'tsx',
    },
    outfile: path.join(reportDir, 'harness.js'),
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  })
  for (const output of compiled.outputFiles) {
    const extension = path.extname(output.path)
    assert(['.js', '.css'].includes(extension), 'Unexpected fixture asset')
    await page.route(`${base}/__focus-recovery${extension}`, (route) =>
      route.fulfill({
        contentType:
          extension === '.js' ? 'application/javascript' : 'text/css',
        body: Buffer.from(output.contents),
      }),
    )
  }
  await page.goto(`${base}/__focus-recovery`)
  await page.getByLabel('Focused proof', { exact: true }).waitFor()
  results.beforeRestore = await page
    .getByLabel('Focused proof', { exact: true })
    .innerText()
  releaseChats()
  await until(
    async () =>
      (await page.getByLabel('Select chat').getByRole('option').count()) >= 3,
    'chat list restoration',
  )
  await page.waitForTimeout(100)
  results.afterRestore = await page
    .getByLabel('Focused proof', { exact: true })
    .allInnerTexts()
  assert.equal(
    await page.getByLabel('Focused proof', { exact: true }).count(),
    1,
    'Startup must preserve an explicit proof focus rather than silently restoring another chat.',
  )
  assert.match(results.afterRestore[0], /second/)
  assert.equal(
    await page.getByLabel('Select chat').inputValue(),
    '',
    'Focused new draft remains selected after chat restoration.',
  )
  results.checks.push(
    'An explicit proof focus on first assistant mount stays visible after saved chats load.',
  )
  const composer = page.getByLabel('Message Lemex')
  await composer.fill('Preserve custom focus instructions.')
  await page.getByLabel('Select chat').selectOption('other-chat')
  await until(
    async () =>
      (await page.getByLabel('Focused proof', { exact: true }).count()) === 0,
    'other chat has no target',
  )
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByLabel('Focused proof', { exact: true }).waitFor()
  assert.match(
    await page.getByLabel('Focused proof', { exact: true }).innerText(),
    /second/,
  )
  assert.equal(
    await composer.inputValue(),
    'Preserve custom focus instructions.',
  )
  results.checks.push(
    'Focus and instructions remain in their own draft when switching chats and returning.',
  )
  await page.reload()
  await page.getByLabel('Focused proof', { exact: true }).waitFor()
  await until(
    async () =>
      (await page.getByLabel('Select chat').getByRole('option').count()) >= 3,
    'reload chat restoration',
  )
  assert.equal(await page.getByLabel('Select chat').inputValue(), '')
  assert.equal(
    await composer.inputValue(),
    'Preserve custom focus instructions.',
  )
  results.checks.push(
    'Focused draft and custom instructions survive reload without a save, chat creation, or agent call.',
  )
  await page.getByLabel('Select chat').selectOption('other-chat')
  await until(
    async () =>
      (await page.getByLabel('Focused proof', { exact: true }).count()) === 0,
    'empty existing-chat draft',
  )
  await page.evaluate(
    ({ projectId, target }) =>
      window.__focusRecoveryRender({
        focusRequest: {
          id: 2,
          projectId,
          target: {
            ...target,
            name: 'first',
            startLine: 1,
            endLine: 2,
            source: 'theorem first : True := by\n  trivial',
          },
          mode: 'optimize',
        },
      }),
    { projectId, target },
  )
  await page.getByLabel('Focused proof', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Select chat').inputValue(), 'other-chat')
  assert.match(
    await page.getByLabel('Focused proof', { exact: true }).innerText(),
    /first/,
  )
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await until(
    async () =>
      /second/.test(
        await page.getByLabel('Focused proof', { exact: true }).innerText(),
      ),
    'return to original proof focus',
  )
  assert.equal(
    await composer.inputValue(),
    'Preserve custom focus instructions.',
  )
  results.checks.push(
    'Focusing a different proof attaches to the selected existing chat and leaves the original draft target intact.',
  )
  assert.equal(
    report.requests.filter((request) => request.method !== 'GET').length,
    0,
    'Attaching and restoring focus never saves or sends.',
  )
  fixture.assertClean()
  results.passed = true
  await page.screenshot({ path: path.join(reportDir, 'focused-draft.png') })
} catch (error) {
  results.failure = error.stack || String(error)
  results.pageText = await page.locator('body').innerText()
  await page.screenshot({ path: path.join(reportDir, 'failure.png') })
  process.exitCode = 1
} finally {
  releaseChats()
  results.browser = report
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(results, null, 2),
  )
  console.log(
    JSON.stringify(
      {
        checks: results.checks,
        passed: results.passed,
        failure: results.failure,
        report: path.join(reportDir, 'result.json'),
      },
      null,
      2,
    ),
  )
  await browser.close()
}
