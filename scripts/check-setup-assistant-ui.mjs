#!/usr/bin/env node
// All setup, chat and Lean operations are closed fixtures; no provider is called.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/setup-assistant-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const base = `http://127.0.0.1:${server.address().port}`
const checks = []
let fixture
try {
  for (const initialStatus of ['error', 'needs-setup']) {
    const id = `setup-assistant-${initialStatus}`
    const pinned = 'leanprover/lean4:v4.34.1'
    const project = {
      id,
      name: 'Setup help fixture',
      status: initialStatus,
      ...(initialStatus === 'error'
        ? {
            needsPreparation: true,
            error: 'APP_GENERATED_SETUP_ERROR_SENTINEL',
            log:
              'APP_GENERATED_SETUP_LOG_SENTINEL\n' +
              Array.from(
                { length: 300 },
                (_, index) => `Setup output ${index}\n`,
              ).join(''),
            toolchain: pinned,
          }
        : {}),
    }
    fixture = await chatBrowserFixture({
      base,
      session: {
        user: { id: 'setup-help-user', name: 'Setup helper' },
        templates: [
          { id: 'lean', name: 'Lean basics', ready: true, toolchain: pinned },
        ],
        models: [
          {
            id: 'default-model',
            name: 'Default model',
            reasoningEfforts: [{ id: 'high' }, { id: 'max' }],
          },
          {
            id: 'chosen-model',
            name: 'Chosen model',
            reasoningEfforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }],
          },
        ],
        defaultModel: 'default-model',
        runtime: { ready: true },
        lemex: { configured: true },
      },
      projects: [project],
      files: {
        [id]: {
          'Main.lean': 'example : True := by trivial\n',
          'lakefile.toml': 'name = "fixture"\n',
        },
      },
      chats: [{ id: `${id}-chat`, projectId: id, title: 'Setup conversation' }],
      runs: [],
    })
    const { page, state } = fixture
    const started = []
    let runStops = 0
    let setupStarts = 0
    let setupStops = 0
    state.onCreateRun = ({ chat, body, respond }) => {
      started.push(body)
      const run = {
        ...body,
        id: `${id}-run-${started.length}`,
        projectId: id,
        chatId: chat.id,
        status: 'running',
        createdAt: new Date().toISOString(),
        message: 'Fixture setup diagnosis.',
        eventCursor: 0,
        followups: [],
        changes: [],
      }
      state.runs.push(run)
      return respond(run, 201)
    }
    state.onStop = ({ run, respond }) => {
      runStops++
      run.status = 'cancelled'
      return respond(run)
    }
    await page.route(`**/api/projects/${id}/prepare`, (route) => {
      setupStarts++
      project.status = 'preparing'
      project.setupPhase = 'preparing-dependencies'
      project.setupStartedAt = new Date().toISOString()
      return route.fulfill({ json: project })
    })
    await page.route(`**/api/projects/${id}/prepare/stop`, (route) => {
      setupStops++
      project.status = 'error'
      project.needsPreparation = true
      project.error = 'Project setup stopped. You can retry when ready.'
      return route.fulfill({ json: project })
    })
    await page.goto(base)
    const composer = page.getByLabel('Message Lemex', { exact: true })
    await composer.waitFor()
    await page.locator('.chat-options').evaluate((element) => {
      element.open = true
    })
    const model = page.getByRole('combobox', { name: 'Model', exact: true })
    const effort = page.getByRole('combobox', {
      name: 'Reasoning effort',
      exact: true,
    })
    await model.selectOption('chosen-model')
    await effort.selectOption('low')
    await composer.fill('Keep my existing request.')
    const help = page.getByRole('button', {
      name: 'Ask Lemex to fix setup',
      exact: true,
    })
    if (initialStatus === 'error') {
      const actionBounds = await help.boundingBox()
      const panelBounds = await page
        .locator('.setup-editor-details')
        .boundingBox()
      assert(actionBounds && panelBounds)
      assert(
        actionBounds.y + actionBounds.height <=
          panelBounds.y + panelBounds.height,
      )
    }
    await help.click()
    await until(
      async () =>
        (await composer.inputValue()).includes(
          'Help me get this project ready.',
        ),
      'setup request added to the draft',
    )
    const requested = await composer.inputValue()
    assert(requested.startsWith('Keep my existing request.\n\n'))
    assert.equal(await model.inputValue(), 'chosen-model')
    assert.equal(await effort.inputValue(), 'low')
    assert.equal(
      await page
        .locator('.mode-tabs')
        .getByRole('button', { name: 'Ask & Search', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    )
    assert.equal(
      await composer.evaluate((element) => element === document.activeElement),
      true,
    )
    assert.equal(started.length, 0)
    const setupNotice = page.getByText(
      'Setup help: review configuration changes before applying.',
      { exact: true },
    )
    await setupNotice.waitFor()
    const liveEdits = page.getByLabel('Edit files live', { exact: true })
    assert.equal(await liveEdits.isChecked(), false)
    assert.equal(await liveEdits.isDisabled(), true)
    await help.click()
    assert.equal(await composer.inputValue(), requested)
    // The scope is part of the saved draft, not just a transient panel flag.
    await page.reload()
    await setupNotice.waitFor()
    assert.equal(await composer.inputValue(), requested)
    await page.locator('.chat-options').evaluate((element) => {
      element.open = true
    })
    assert.equal(await liveEdits.isChecked(), false)
    assert.equal(await liveEdits.isDisabled(), true)
    await page
      .getByRole('button', { name: 'Exit setup help', exact: true })
      .click()
    assert.equal(await composer.inputValue(), requested)
    assert.equal(await liveEdits.isChecked(), true)
    assert.equal(await liveEdits.isEnabled(), true)
    await model.selectOption('chosen-model')
    await effort.selectOption('low')
    await help.click()
    assert.equal(await composer.inputValue(), requested)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await until(() => started.length === 1, 'manual setup assistant starts')
    assert.equal(started[0].mode, 'search')
    assert.equal(started[0].model, 'chosen-model')
    assert.equal(started[0].effort, 'low')
    assert.equal(started[0].purpose, 'setup')
    assert.equal(started[0].liveEdits, false)
    assert.equal(started[0].proofTarget, undefined)
    assert.equal(started[0].prompt, requested)
    assert.equal(
      JSON.stringify(started[0]).includes('APP_GENERATED_SETUP_'),
      false,
    )
    await composer.fill('Keep this next draft.')
    assert.equal(
      await page
        .getByRole('button', { name: 'Exit setup help', exact: true })
        .isDisabled(),
      true,
    )
    for (const option of await page.locator('.mode-tabs button').all())
      assert.equal(await option.isDisabled(), true)
    await page
      .getByRole('button', { name: 'Stop', exact: true })
      .first()
      .click()
    await until(() => runStops === 1, 'manual assistant can be stopped')
    assert.equal(await composer.inputValue(), 'Keep this next draft.')
    checks.push(
      `${initialStatus}: setup help keeps the draft, chosen model/effort and ordinary chat cancellation; no diagnostics are fabricated as user text`,
    )
    if (initialStatus === 'error') {
      await page.evaluate(() => {
        window.__setupComposer = document.getElementById('assistant-prompt')
      })
      await page
        .getByRole('button', { name: 'Retry setup', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Stop setup', exact: true })
        .waitFor()
      await page
        .getByText(/Project setup is running\. You can keep a draft here\./)
        .waitFor()
      assert.equal(await composer.inputValue(), 'Keep this next draft.')
      assert.equal(
        await page.evaluate(
          () =>
            window.__setupComposer ===
            document.getElementById('assistant-prompt'),
        ),
        true,
      )
      assert.equal(
        await page
          .getByRole('button', { name: 'Send', exact: true })
          .isDisabled(),
        true,
      )
      assert.equal(
        await page
          .getByRole('button', { name: 'New chat', exact: true })
          .isDisabled(),
        true,
      )
      assert.equal(await page.getByText(/You have viewer access/).count(), 0)
      await page
        .locator('.assistant-composer')
        .evaluate((form) => form.requestSubmit())
      assert.equal(started.length, 1)
      await page
        .getByRole('button', { name: 'Stop setup', exact: true })
        .click()
      await until(() => setupStops === 1, 'setup cancellation finishes')
      await page
        .getByRole('button', { name: 'Retry setup', exact: true })
        .waitFor()
      assert.equal(await composer.inputValue(), 'Keep this next draft.')
      assert.equal(
        await page
          .getByRole('button', { name: 'Send', exact: true })
          .isEnabled(),
        true,
      )
      await page
        .getByRole('button', { name: 'Retry setup', exact: true })
        .click()
      await until(() => setupStarts === 2, 'setup can be retried')
      project.status = 'ready'
      project.needsPreparation = false
      delete project.error
      await page.locator('.monaco-editor').waitFor()
      assert.equal(project.toolchain, pinned)
      assert.equal(await composer.inputValue(), 'Keep this next draft.')
      assert.equal(await model.inputValue(), 'chosen-model')
      assert.equal(await effort.inputValue(), 'low')
      assert.equal(
        await page.evaluate(
          () =>
            window.__setupComposer ===
            document.getElementById('assistant-prompt'),
        ),
        true,
      )
      checks.push(
        'Error, preparation, cancellation and ready transitions preserve the mounted conversation, draft and chosen options; preparation blocks competing tasks with a busy notice',
      )
      await page
        .getByRole('button', { name: 'Exit setup help', exact: true })
        .click()
      assert.equal(await liveEdits.isChecked(), true)
      assert.equal(await liveEdits.isEnabled(), true)
      await composer.fill('Organize the project notes.')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await until(
        () => started.length === 2,
        'ordinary assistant task starts after exiting setup help',
      )
      assert.equal(started[1].purpose, undefined)
      assert.equal(started[1].liveEdits, true)
      await page.locator('.setup-editor-details').evaluate((element) => {
        element.open = true
      })
      await help.click()
      await page
        .getByText(
          'Stop the current task before starting setup help. Your draft is kept.',
          { exact: true },
        )
        .waitFor()
      assert.equal(
        await page
          .getByRole('button', { name: 'Send update', exact: true })
          .isDisabled(),
        true,
      )
      await page
        .locator('.assistant-composer')
        .evaluate((form) => form.requestSubmit())
      assert.equal(started.length, 2)
      await page
        .getByRole('button', { name: 'Stop', exact: true })
        .first()
        .click()
      await until(() => runStops === 2, 'ordinary task can be stopped')
      checks.push(
        'Setup scope survives reload, locks live edits off and requires explicit review; Exit restores ordinary search preferences and broad project tasks',
      )
    }
    fixture.assertClean()
    await fixture.browser.close()
    fixture = null
  }
  console.log(JSON.stringify({ passed: true, checks }, null, 2))
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ passed: true, checks }, null, 2),
  )
} catch (error) {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: false,
        checks,
        error: error.stack,
        pageText: await fixture?.page.locator('body').innerText(),
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
