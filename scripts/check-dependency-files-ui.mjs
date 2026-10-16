#!/usr/bin/env node
// Dependency browsing uses an isolated client and mocked project/Lean traffic.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/dependency-files-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(
  express.static(
    process.env.STUDIO_TEST_DIST || path.join(root, 'client/dist'),
  ),
)
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const projectId = 'dependency-files-project'
const otherId = 'other-dependency-project'
const dependency = '.lake/packages/Cli/CliTest/Example.lean'
const readme = '.lake/packages/Cli/README.md'
const configuration = '.lake/packages/Cli/lakefile.toml'
const failing = '.lake/packages/Cli/Retry.lean'
const main = 'def projectValue : Nat := 1\n#check projectValue\n'
const sources = {
  'Main.lean': main,
  [dependency]: '-- CLI_LIBRARY_SOURCE\ndef cliExample : Nat := 2\n',
  [readme]: '# CLI_README_SOURCE\n\nLibrary documentation.\n',
  [configuration]: 'name = "CLI_CONFIG_SOURCE"\n',
  [failing]: '-- RETRY_LIBRARY_SOURCE\nexample : True := by trivial\n',
}
let fixture
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'Dependency browsing', status: 'ready' },
      { id: otherId, name: 'Other dependency project', status: 'ready' },
    ],
    files: {
      [projectId]: sources,
      [otherId]: {
        'Main.lean': '-- SECOND_PROJECT_SOURCE\nexample : True := by trivial\n',
        [dependency]: '-- SECOND_PROJECT_LIBRARY\ndef cliExample : Nat := 3\n',
        [readme]: '# SECOND_PROJECT_README\n',
      },
    },
    chats: [
      { id: 'dependency-chat', projectId, title: 'Fixture chat' },
      { id: 'other-chat', projectId: otherId, title: 'Other fixture chat' },
    ],
    runs: [],
  })
  const { page, report } = fixture
  const writes = []
  const requestSources = (request) => {
    const id = new URL(request.url()).pathname.split('/')[3]
    return fixture.state.files[id]
  }
  await page.route('**/api/projects/*/files', (route) =>
    route.fulfill({
      json: Object.entries(requestSources(route.request())).map(
        ([path, content]) => ({
          path,
          size: Buffer.byteLength(content),
          readOnly: path.startsWith('.lake/'),
        }),
      ),
    }),
  )
  await page.route('**/api/projects/*/file?*', (route) => {
    const filename = new URL(route.request().url()).searchParams.get('path')
    if (route.request().method() !== 'GET') {
      writes.push(filename)
      return route.fulfill({ status: 403, json: { error: 'Read only.' } })
    }
    const content = requestSources(route.request())[filename]
    assert.equal(typeof content, 'string')
    return route.fulfill({
      json: {
        content,
        hash: createHash('sha256').update(content).digest('hex'),
        readOnly: filename.startsWith('.lake/'),
      },
    })
  })
  // The older editor tries to write before opening this read-only fallback.
  await page.route('**/api/projects/*/library-source', (route) => {
    const { uri } = route.request().postDataJSON()
    const filename = decodeURIComponent(new URL(uri).pathname).slice(
      '/workspace/'.length,
    )
    const files = requestSources(route.request())
    assert(Object.hasOwn(files, filename))
    return route.fulfill({
      json: { content: files[filename], readOnly: true, line: 1 },
    })
  })

  const input = () => page.locator('.monaco-editor textarea').first()
  const save = page.getByRole('button', { name: 'Save', exact: true })
  async function opened(filename, marker) {
    await until(async () => {
      return (
        (await page.locator('.editor-failure').count()) === 0 &&
        (await page.locator('.editor-loading').count()) === 0 &&
        (await page.locator('.file-toolbar').innerText()).includes(filename) &&
        (await page.locator('.monaco-editor .view-lines').innerText()).includes(
          marker,
        )
      )
    }, `opening ${filename}`)
  }
  async function open(filename, marker) {
    await page.locator(`.file-item[title="${filename}"]`).click()
    await opened(filename, marker)
  }
  async function readonly(filename, marker) {
    await open(filename, marker)
    await page
      .locator('.file-toolbar')
      .getByText('Read only', { exact: true })
      .waitFor()
    await input().focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('FORBIDDEN_DEPENDENCY_EDIT')
    assert.equal(await save.isEnabled(), false)
    assert(
      !(await page.locator('.monaco-editor .view-lines').innerText()).includes(
        'FORBIDDEN_DEPENDENCY_EDIT',
      ),
    )
    assert.equal(writes.length, 0)
  }

  await fixture.ready()
  await page.getByRole('button', { name: /^Dependencies/ }).click()
  await readonly(dependency, 'CLI_LIBRARY_SOURCE')
  await open('Main.lean', 'projectValue')
  await readonly(readme, 'CLI_README_SOURCE')
  await readonly(configuration, 'CLI_CONFIG_SOURCE')
  await readonly(dependency, 'CLI_LIBRARY_SOURCE')
  report.checks.push(
    'Dependency Lean source, Markdown and configuration open read-only, reject edits, and can be reopened without a reload or writes.',
  )

  await open('Main.lean', 'projectValue')
  await input().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('-- PROJECT_STILL_EDITABLE\n')
  await until(
    () => save.isEnabled(),
    'project editing after dependency browsing',
  )
  await page.locator(`.file-item[title="${dependency}"]`).click()
  const unsaved = page.getByRole('dialog', { name: 'Save your changes?' })
  await unsaved.waitFor()
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await save.isEnabled(), true)
  assert(
    (await page.locator('.monaco-editor .view-lines').innerText()).includes(
      'PROJECT_STILL_EDITABLE',
    ),
  )
  await page.locator(`.file-item[title="${dependency}"]`).click()
  await unsaved.getByRole('button', { name: 'Discard edits' }).click()
  await opened(dependency, 'CLI_LIBRARY_SOURCE')
  report.checks.push(
    'Returning to the project restores editing and keeps the existing unsaved-change prompt when opening a dependency.',
  )

  // Simulate one local model-initialization failure without production hooks.
  await page.evaluate(() => {
    const encode = TextEncoder.prototype.encode
    TextEncoder.prototype.encode = function (text) {
      if (text?.startsWith('-- RETRY_LIBRARY_SOURCE')) {
        TextEncoder.prototype.encode = encode
        throw new Error('Fixture editor initialization failed once.')
      }
      return encode.call(this, text)
    }
  })
  await page.locator(`.file-item[title="${failing}"]`).click()
  await page.locator('.editor-failure').waitFor()
  await open('Main.lean', 'projectValue')
  await readonly(dependency, 'CLI_LIBRARY_SOURCE')
  report.checks.push(
    'After a file fails to open, both project files and other dependencies remain usable without reloading the page.',
  )

  await page.locator('.project-item[title="Other dependency project"]').click()
  await opened('Main.lean', 'SECOND_PROJECT_SOURCE')
  const toggle = page.getByRole('button', { name: /^Dependencies/ })
  if ((await toggle.getAttribute('aria-expanded')) === 'false')
    await toggle.click()
  await readonly(dependency, 'SECOND_PROJECT_LIBRARY')
  await readonly(readme, 'SECOND_PROJECT_README')
  await page.locator('.project-item[title="Dependency browsing"]').click()
  await opened(dependency, 'CLI_LIBRARY_SOURCE')
  if ((await toggle.getAttribute('aria-expanded')) === 'false')
    await toggle.click()
  await readonly(readme, 'CLI_README_SOURCE')
  report.checks.push(
    'Projects with identical dependency paths show their own sources and documentation when switching in both directions.',
  )
  fixture.assertClean()
  assert.equal(writes.length, 0)
  report.ok = true
  await page.screenshot({ path: path.join(output, 'dependencies.png') })
} catch (error) {
  if (fixture) {
    fixture.report.failure = error.stack || String(error)
    fixture.report.pageText = await fixture.page.locator('body').innerText()
    await fixture.page.screenshot({ path: path.join(output, 'failure.png') })
  }
  throw error
} finally {
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  JSON.stringify(
    { ok: fixture.report.ok, checks: fixture.report.checks, output },
    null,
    2,
  ),
)
