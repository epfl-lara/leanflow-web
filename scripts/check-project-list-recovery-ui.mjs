#!/usr/bin/env node
// Closed API/editor fixture: a failed list load must stay distinct from no projects.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/project-list-recovery-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const base = `http://127.0.0.1:${server.address().port}`
const result = { checks: [] }
try {
  for (const mode of [
    'returning-user',
    'empty-account',
    'viewer-without-key',
  ]) {
    const projectId = 'project-list-recovery-project'
    const fixture = await chatBrowserFixture({
      base,
      session: {
        user: { id: 'project-list-recovery-user', name: 'Recovery fixture' },
        templates: [],
        models: [{ id: 'fixture', name: 'Fixture' }],
        defaultModel: 'fixture',
        runtime: { ready: true },
        lemex: { configured: mode !== 'viewer-without-key' },
      },
      projects: [
        {
          id: projectId,
          name: 'Existing project',
          status: 'ready',
          ...(mode === 'viewer-without-key' ? { accessRole: 'viewer' } : {}),
        },
      ],
      files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
      chats: [
        {
          id: 'project-list-recovery-chat',
          projectId,
          title: 'Recovery fixture',
        },
      ],
      runs: [],
    })
    const { page, state } = fixture
    let attempts = 0
    let releaseFirst
    let accountSwitched = false
    let releaseSwitchedList
    await page.route('**/api/logout', (route) =>
      route.fulfill({ json: { ok: true } }),
    )
    await page.route('**/api/login', (route) => {
      assert.equal(route.request().postDataJSON().token, 'second-fixture-token')
      accountSwitched = true
      state.session = {
        ...state.session,
        user: { id: 'second-project-list-user', name: 'Second fixture user' },
      }
      return route.fulfill({ json: { user: state.session.user } })
    })
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      attempts++
      if (accountSwitched) {
        await new Promise((resolve) => {
          releaseSwitchedList = resolve
        })
        return route.fulfill({ json: [] })
      }
      if (attempts === 1) {
        await new Promise((resolve) => {
          releaseFirst = resolve
        })
        return route.fulfill({
          status: 503,
          json: { error: 'Project list is temporarily unavailable.' },
        })
      }
      return mode === 'empty-account'
        ? route.fulfill({ json: [] })
        : route.fallback()
    })
    try {
      await page.goto(base)
      await until(() => !!releaseFirst, 'initial project list request')
      if (mode === 'viewer-without-key')
        await page
          .getByRole('heading', {
            name: 'Welcome, Recovery fixture.',
            exact: true,
          })
          .waitFor()
      else
        await page
          .getByText('Loading your projects…', { exact: true })
          .waitFor()
      assert.equal(
        await page
          .getByRole('heading', {
            name: 'Start with your project.',
            exact: true,
          })
          .count(),
        0,
      )
      releaseFirst()
      if (mode !== 'viewer-without-key')
        await page
          .getByRole('heading', {
            name: 'Your projects could not load',
            exact: true,
          })
          .waitFor()
      await page
        .getByRole('alert')
        .filter({ hasText: 'Project list is temporarily unavailable.' })
        .waitFor()
      assert.equal(attempts, 1)
      assert.equal(
        await page
          .getByRole('heading', {
            name: 'Start with your project.',
            exact: true,
          })
          .count(),
        0,
      )
      await page
        .getByRole('button', { name: 'Retry loading projects', exact: true })
        .click()
      if (mode !== 'empty-account') {
        await page.locator('.monaco-editor').waitFor()
        assert.equal(
          await page
            .getByRole('heading', {
              name: 'Start with your project.',
              exact: true,
            })
            .count(),
          0,
        )
      } else {
        await page
          .getByRole('heading', {
            name: 'Start with your project.',
            exact: true,
          })
          .waitFor()
        assert.equal(await page.locator('.monaco-editor').count(), 0)
      }
      assert(attempts >= 2)
      assert.equal(
        await page
          .getByRole('button', { name: 'Retry loading projects', exact: true })
          .count(),
        0,
      )
      if (mode === 'returning-user') {
        await page
          .getByRole('button', { name: 'Sign out', exact: true })
          .click()
        await page
          .getByLabel('Access token', { exact: true })
          .fill('second-fixture-token')
        await page
          .getByRole('button', { name: 'Open workspace', exact: true })
          .click()
        await until(
          () => !!releaseSwitchedList,
          'second account project list request',
        )
        await page
          .getByText('Loading your projects…', { exact: true })
          .waitFor()
        assert.equal(
          (await page.locator('.user-name').innerText()).trim(),
          'Second fixture user',
        )
        assert.equal(
          (await page.locator('body').innerText()).includes('Existing project'),
          false,
        )
        releaseSwitchedList()
        await page
          .getByRole('heading', {
            name: 'Start with your project.',
            exact: true,
          })
          .waitFor()
        result.checks.push(
          'Signing out removes the prior account project names before another account loads its project list',
        )
      }
      fixture.assertClean()
      result.checks.push({
        mode,
        retryRecovered: true,
        firstRunShownOnlyAfterSuccessfulEmptyList: true,
      })
    } finally {
      releaseFirst?.()
      releaseSwitchedList?.()
      await fixture.browser.close()
    }
  }
  result.passed = true
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  result.error = error.stack
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  await new Promise((resolve) => server.close(resolve))
}
