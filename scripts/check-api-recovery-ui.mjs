#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/api-recovery-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const base = `http://127.0.0.1:${server.address().port}`
const report = { passed: false, cases: [] }
try {
  for (const failure of ['connection-reset', 'busy']) {
    const projectId = 'api-recovery-project'
    const fixture = await chatBrowserFixture({
      base,
      session: {
        user: {
          id: 'api-recovery-user',
          name: 'Recovery fixture',
          role: 'user',
          profileComplete: true,
        },
        templates: [],
        models: [{ id: 'fixture', name: 'Fixture' }],
        defaultModel: 'fixture',
        runtime: { ready: true },
        lemex: { configured: true },
      },
      projects: [{ id: projectId, name: 'Recovered project', status: 'ready' }],
      files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
      chats: [
        { id: 'api-recovery-chat', projectId, title: 'Recovery fixture' },
      ],
      runs: [],
    })
    let attempts = 0
    const acceptedAt = []
    await fixture.page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      attempts++
      acceptedAt.push(Date.now())
      if (
        attempts === 1 ||
        (failure === 'busy' && Date.now() - acceptedAt[0] < 950)
      ) {
        if (failure === 'connection-reset')
          return route.abort('connectionreset')
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '1' },
          json: { error: 'Brief fixture backpressure.' },
        })
      }
      return route.fallback()
    })
    try {
      await fixture.ready()
      assert(attempts >= 2)
      if (failure === 'busy')
        assert(acceptedAt.some((at) => at - acceptedAt[0] >= 950))
      assert.equal(
        await fixture.page
          .getByRole('heading', {
            name: 'Your projects could not load',
            exact: true,
          })
          .count(),
        0,
      )
      assert.equal(
        await fixture.page
          .getByRole('button', { name: 'Retry loading projects', exact: true })
          .count(),
        0,
      )
      const text = await fixture.page.locator('body').innerText()
      assert(!text.includes('Failed to fetch'))
      assert.equal(fixture.state.runs.length, 0)
      fixture.assertClean()
      report.cases.push({ failure, attempts, recovered: true, modelRuns: 0 })
    } finally {
      await fixture.browser.close()
    }
  }
  report.passed = true
  console.log(JSON.stringify(report))
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await new Promise((resolve) => server.close(resolve))
}
