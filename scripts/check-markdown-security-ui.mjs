#!/usr/bin/env node
// Real Markdown/KaTeX rendering, closed project/Lean fixtures, no model requests.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/markdown-security-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const projectId = 'markdown-project'
const chatId = 'markdown-chat'
const run = (id, message) => ({
  id,
  projectId,
  chatId,
  kind: 'agent',
  mode: 'search',
  status: 'completed',
  createdAt:
    id === 'valid-math' ? '2026-10-19T00:00:00Z' : '2026-10-19T00:01:00Z',
  prompt: 'Render this fixture response.',
  message,
  followups: [],
})
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'markdown-owner', name: 'Markdown fixture', role: 'user' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [{ id: projectId, name: 'Markdown fixture', status: 'ready' }],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: chatId, projectId, title: 'Markdown rendering', runCount: 2 }],
  runs: [
    run(
      'valid-math',
      String.raw`Inline math: $a^2+b^2=c^2$ and \(\alpha+\beta\).

$$
\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}
$$

| Theorem | Result |
| --- | --- |
| Pythagoras | **Verified** |`,
    ),
    run(
      'unsafe-markup',
      String.raw`Untrusted fixture:

<script>window.__markdownExecuted=true</script>
<img src="https://markdown-security.invalid/raw.png" onerror="window.__markdownExecuted=true">
<iframe src="https://markdown-security.invalid/frame"></iframe>

[Unsafe link](javascript:alert(1))

![External diagram](https://markdown-security.invalid/diagram.png)

$\href{https://markdown-security.invalid/katex-link}{UnsafeKaTeXLink}$

$\htmlClass{injected-katex-class}{UnsafeClass}$

$\htmlStyle{position:fixed;top:0}{UnsafeStyle}$

$\includegraphics{https://markdown-security.invalid/katex-image.png}$`,
    ),
  ],
})
const { page, browser, report } = fixture
let remoteRequests = 0
await page.addInitScript(() => {
  window.__markdownExecuted = false
})
await page.route('https://markdown-security.invalid/**', async (route) => {
  ++remoteRequests
  await route.abort('blockedbyclient')
})
try {
  await fixture.ready()
  const valid = page.locator('[data-run-id="valid-math"] .message-body')
  const untrusted = page.locator('[data-run-id="unsafe-markup"] .message-body')
  await valid.locator('.katex').first().waitFor()
  await untrusted
    .getByRole('link', { name: 'Image: External diagram' })
    .waitFor()
  assert.equal(await valid.locator('.katex').count(), 3)
  assert.equal(await valid.locator('.katex-display').count(), 1)
  assert.equal(await valid.locator('.katex-error').count(), 0)
  assert.equal(await valid.locator('table tbody tr').count(), 1)
  report.checks.push(
    'Inline, alternate-delimiter, and display math render without KaTeX errors; Markdown tables remain intact',
  )
  assert.equal(
    await untrusted
      .locator('script, img, iframe, [onerror], .injected-katex-class')
      .count(),
    0,
  )
  assert.equal(await page.evaluate(() => window.__markdownExecuted), false)
  assert.equal(
    await untrusted.locator('a[href^="javascript:"], a[href^="data:"]').count(),
    0,
  )
  assert.equal(await untrusted.locator('a[href*="katex-link"]').count(), 0)
  assert.equal(await untrusted.locator('[style*="position:fixed"]').count(), 0)
  assert.equal(remoteRequests, 0)
  report.checks.push(
    'Raw HTML and unsafe links cannot execute; KaTeX trust-only HTML/link/image commands create no active elements or outbound requests',
  )
  const imageLink = untrusted.getByRole('link', {
    name: 'Image: External diagram',
  })
  assert.equal(
    await imageLink.getAttribute('href'),
    'https://markdown-security.invalid/diagram.png',
  )
  assert.match(await imageLink.getAttribute('rel'), /noopener/)
  report.checks.push(
    'Remote Markdown images remain deliberate links and are never fetched automatically',
  )
  await valid.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: new URL('math-rendering.png', directory).pathname,
  })
  await untrusted.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: new URL('untrusted-markdown.png', directory).pathname,
  })
  fixture.assertClean()
  report.remoteRequests = remoteRequests
  report.inferenceRequests = 0
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
  await page
    .screenshot({ path: new URL('failure.png', directory).pathname })
    .catch(() => {})
} finally {
  await fs.writeFile(
    new URL('report.json', directory),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks,
      error: report.error,
    }),
  )
  await browser.close()
}
