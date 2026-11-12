#!/usr/bin/env node
// Browser-only session fixtures: no real accounts, providers, or proof runs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/session-inactivity-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const fixture = await chatBrowserFixture({
  session: {
    user: {
      id: 'idle-session-user',
      name: 'Session fixture',
      role: 'user',
      profileComplete: true,
    },
    templates: [],
    models: [{ id: 'fixture/model', name: 'Fixture model' }],
    defaultModel: 'fixture/model',
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [{ id: 'idle-project', name: 'Session fixture', status: 'ready' }],
  files: { 'idle-project': { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [
    { id: 'idle-chat', projectId: 'idle-project', title: 'Session fixture' },
  ],
  runs: [],
})
const { page, browser, state, report } = fixture
let renewals = 0
let expireNextRenewal = false
let logins = 0
let authenticated = true
let logoutAttempts = 0
let failNextLogout = false
let holdNextRenewal = false
let releaseRenewal
await page.route('**/api/session', (route) =>
  route.fulfill(
    authenticated
      ? { json: state.session }
      : { status: 401, json: { error: 'Please sign in.' } },
  ),
)
await page.route('**/api/session/activity', async (route) => {
  assert.equal(route.request().method(), 'POST')
  assert.deepEqual(route.request().postDataJSON(), {})
  renewals++
  if (expireNextRenewal) {
    expireNextRenewal = false
    authenticated = false
    return route.fulfill({ status: 401, json: { error: 'Session expired.' } })
  }
  if (holdNextRenewal) {
    holdNextRenewal = false
    await new Promise((resolve) => {
      releaseRenewal = resolve
    })
  }
  authenticated = true
  return route.fulfill({
    json: { ok: true },
    headers: {
      'Set-Cookie':
        'lemex_web=fixture-session; Path=/; HttpOnly; SameSite=Strict',
    },
  })
})
await page.route('**/api/login', async (route) => {
  assert.deepEqual(route.request().postDataJSON(), {
    token: 'fixture-personal-token',
    expectedUserId: state.session.user.id,
  })
  logins++
  authenticated = true
  return route.fulfill({ json: { user: state.session.user } })
})
await page.route('**/api/logout', (route) => {
  logoutAttempts++
  if (failNextLogout) {
    failNextLogout = false
    return route.fulfill({
      status: 503,
      json: { error: 'Could not sign out. Please try again.' },
    })
  }
  authenticated = false
  return route.fulfill({
    json: { ok: true },
    headers: {
      'Set-Cookie': 'lemex_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    },
  })
})

try {
  await page.clock.install()
  await fixture.ready()
  await until(() => renewals === 1, 'initial signed-in session renewal')
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100)
  const initialRenewals = renewals
  await page.evaluate(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
    )
    document.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, bubbles: true }),
    )
    // These model the reads made by normal editor and chat polling.
    for (let poll = 0; poll < 3; poll++) await fetch('/api/session')
  })
  await page.clock.fastForward(180000)
  assert.equal(renewals, initialRenewals)
  report.checks.push(
    'Opening a signed-in workspace renews the session once; background requests, synthetic events, and an unattended visible tab do not keep renewing it.',
  )

  const composer = page.getByLabel('Message Lemex')
  await composer.focus()
  await page.keyboard.press('K')
  await page.clock.runFor(1)
  await until(
    () => renewals === initialRenewals + 1,
    'trusted keyboard activity renewal',
  )
  await page.keyboard.type('eep this draft while I renew my session.')
  await page.clock.runFor(30000)
  assert.equal(renewals, initialRenewals + 1)
  await page.clock.runFor(31000)
  await until(
    () => renewals === initialRenewals + 2,
    'trailing activity renewal',
  )
  const afterTyping = renewals
  await page.clock.fastForward(180000)
  assert.equal(renewals, afterTyping)
  report.checks.push(
    'Real typing renews the session, limits a burst to one request per minute, and stops renewing after the last activity.',
  )

  const bounds = await composer.boundingBox()
  assert(bounds)
  await page.mouse.move(bounds.x + 20, bounds.y + 20)
  await page.mouse.wheel(0, 120)
  await page.clock.runFor(1)
  await until(() => renewals === afterTyping + 1, 'trusted scrolling renewal')
  report.checks.push('Real scrolling counts as account activity.')

  const draft = await composer.inputValue()
  expireNextRenewal = true
  await composer.focus()
  await page.keyboard.press('End')
  await page.clock.runFor(61000)
  const recovery = page.getByRole('dialog', {
    name: 'Sign in to continue',
    exact: true,
  })
  await recovery.waitFor()
  assert.equal(await composer.inputValue(), draft)
  const duringRecovery = renewals
  await page.clock.fastForward(180000)
  assert.equal(renewals, duringRecovery)
  await recovery
    .getByLabel('Access token', { exact: true })
    .fill('fixture-personal-token')
  await recovery
    .getByRole('button', { name: 'Continue in workspace', exact: true })
    .click()
  await recovery.waitFor({ state: 'hidden' })
  await page.clock.runFor(1)
  await until(
    () => renewals === duringRecovery + 1,
    'session renewal resumes after recovery',
  )
  assert.equal(logins, 1)
  assert.equal(await composer.inputValue(), draft)
  report.checks.push(
    'An expired renewal opens sign-in recovery without losing the chat draft; renewal pauses during recovery and resumes after signing in.',
  )
  failNextLogout = true
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'Could not sign out. Please try again.' })
    .waitFor()
  assert.equal(logoutAttempts, 1)
  assert.equal(authenticated, true)
  assert.equal(await composer.inputValue(), draft)
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
  await page.clock.fastForward(180000)
  const afterFailedLogout = renewals
  await composer.focus()
  await page.keyboard.press('End')
  await page.clock.runFor(1)
  await until(
    () => renewals > afterFailedLogout,
    'activity renewal after failed sign-out',
  )
  report.checks.push(
    'A failed sign-out preserves the chat draft and resumes activity-based renewal.',
  )

  await page.clock.fastForward(180000)
  holdNextRenewal = true
  await composer.focus()
  await page.keyboard.press('End')
  await page.clock.runFor(1)
  await until(() => !!releaseRenewal, 'delayed renewal response')
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true })
  await signOut.click()
  await until(
    () => page.getByRole('button', { name: /^Signing out/ }).isDisabled(),
    'sign-out waits for pending renewal',
  )
  assert.equal(
    logoutAttempts,
    1,
    'Sign-out must wait for the pending renewal before clearing the cookie',
  )
  releaseRenewal()
  releaseRenewal = undefined
  await page.getByLabel('Access token', { exact: true }).waitFor()
  assert.equal(logoutAttempts, 2)
  assert.equal(authenticated, false)
  const afterLogout = renewals
  await page.clock.fastForward(180000)
  assert.equal(renewals, afterLogout)
  await page.reload()
  await page.getByLabel('Access token', { exact: true }).waitFor()
  assert.equal(authenticated, false)
  assert.equal(renewals, afterLogout)
  assert.equal(
    (await page.context().cookies()).some(
      (cookie) => cookie.name === 'lemex_web',
    ),
    false,
  )
  report.checks.push(
    'Sign-out waits for an in-flight renewal, clears its cookie afterward, and stays signed out across reload.',
  )
  fixture.assertClean()
  report.passed = true
  await page.screenshot({ path: new URL('signed-out.png', directory).pathname })
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
  await page
    .screenshot({ path: new URL('failure.png', directory).pathname })
    .catch(() => {})
} finally {
  releaseRenewal?.()
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
