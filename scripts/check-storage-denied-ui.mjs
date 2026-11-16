#!/usr/bin/env node
// Closed API fixture: denied browser storage must not hide login or lose links.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chromium } from '@playwright/test'

const output = path.resolve('.runtime/storage-denied-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
})
const base = `http://127.0.0.1:${server.address().port}`
const result = { checks: [] }
try {
  for (const mode of ['denied-access', 'denied-operations', 'quota']) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors = []
    const unexpected = []
    const joins = []
    let signedIn = false
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((failureMode) => {
      const fail = () => {
        throw new DOMException(
          'Fixture storage unavailable',
          failureMode === 'quota' ? 'QuotaExceededError' : 'SecurityError',
        )
      }
      if (failureMode === 'denied-access') {
        Object.defineProperty(window, 'localStorage', { get: fail })
        Object.defineProperty(window, 'sessionStorage', { get: fail })
      } else {
        if (failureMode !== 'quota') Storage.prototype.getItem = fail
        Storage.prototype.setItem = fail
        Storage.prototype.removeItem = fail
      }
    }, mode)
    await page.route('**/api/**', (route) => {
      const request = route.request()
      const endpoint = new URL(request.url()).pathname
      const respond = (json, status = 200) => route.fulfill({ status, json })
      const user = {
        id: 'storage-fixture-user',
        name: 'Storage fixture user',
        role: 'user',
        profileComplete: false,
      }
      if (endpoint === '/api/login' && request.method() === 'POST') {
        assert.equal(request.postDataJSON().token, 'fixture-token')
        signedIn = true
        return respond({ user })
      }
      if (endpoint === '/api/session')
        return signedIn
          ? respond({
              user,
              templates: [],
              models: [],
              lemex: { configured: false },
            })
          : respond({ error: 'Sign in to continue.' }, 401)
      if (endpoint === '/api/session/activity')
        return respond({ renewed: true })
      if (endpoint === '/api/projects') return respond([])
      if (endpoint === '/api/project-invitations/join') {
        joins.push(request.postDataJSON().token)
        return mode === 'quota'
          ? respond({ error: 'This fixture invitation has expired.' }, 404)
          : respond({
              id: 'storage-fixture-project',
              name: 'Shared fixture project',
              status: 'ready',
              accessRole: 'viewer',
            })
      }
      if (endpoint === '/api/projects/storage-fixture-project')
        return respond({
          id: 'storage-fixture-project',
          name: 'Shared fixture project',
          status: 'ready',
          accessRole: 'viewer',
        })
      if (endpoint === '/api/projects/storage-fixture-project/files')
        return respond([])
      if (endpoint === '/api/projects/storage-fixture-project/folders')
        return respond([])
      if (endpoint === '/api/projects/storage-fixture-project/checks')
        return respond([])
      if (endpoint === '/api/projects/storage-fixture-project/git')
        return respond({ repository: false })
      unexpected.push(`${request.method()} ${endpoint}`)
      return respond({ error: 'Unexpected fixture request.' }, 500)
    })
    try {
      const invitation = `storage-${mode}`
      const target = `${base}/#share=${invitation}&marker=keep`
      await page.goto(target)
      await page.getByLabel('Access token', { exact: true }).waitFor()
      assert.equal(new URL(page.url()).hash, `#share=${invitation}&marker=keep`)
      await page.reload()
      await page.getByLabel('Access token', { exact: true }).waitFor()
      assert.equal(new URL(page.url()).hash, `#share=${invitation}&marker=keep`)
      await page
        .getByLabel('Access token', { exact: true })
        .fill('fixture-token')
      await page
        .getByRole('button', { name: 'Open workspace', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Welcome, Storage fixture user.' })
        .waitFor()
      if (mode === 'quota') {
        await page
          .getByText('This fixture invitation has expired.', { exact: true })
          .waitFor()
        assert.equal(
          new URL(page.url()).hash,
          `#share=${invitation}&marker=keep`,
        )
        await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
      }
      await page.waitForURL((url) => url.hash === '#marker=keep')
      assert.deepEqual(joins, [invitation])
      assert.deepEqual(errors, [])
      assert.deepEqual(unexpected, [])
      result.checks.push({
        mode,
        loginUsable: true,
        invitationSurvivesReload: true,
        invitationClearedAfter: mode === 'quota' ? 'dismissal' : 'joining',
        unrelatedFragmentPreserved: true,
      })
    } catch (error) {
      result.failedMode = mode
      result.pageErrors = errors
      result.pageText = await page.locator('body').innerText()
      result.unexpectedRequests = unexpected
      throw error
    } finally {
      await context.close()
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
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
