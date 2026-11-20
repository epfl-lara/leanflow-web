#!/usr/bin/env node
// One context menu for files, declarations and lines; all APIs are mocked.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const projectId = 'chat-focus-picker-fixture'
const source =
  'import Init\n\ndef count : Nat := 1\n\ntheorem first : True := by\n  trivial\n\ntheorem second : True := by\n  trivial\n'
const symbols = [
  {
    name: 'count',
    kind: 12,
    range: {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 20 },
    },
  },
  {
    name: 'first',
    kind: 12,
    range: { start: { line: 4, character: 0 }, end: { line: 5, character: 9 } },
  },
  {
    name: 'second',
    kind: 12,
    range: { start: { line: 7, character: 0 }, end: { line: 8, character: 9 } },
  },
]
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'focus-picker-owner', name: 'Fixture' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Focus picker',
      status: 'ready',
      toolchain: 'fixture',
    },
  ],
  files: {
    [projectId]: {
      'Main.lean': source,
      'Other.lean': 'theorem other : True := by trivial\n',
      'Notes.txt': 'Helper notes.',
      'Notes.md': '# Proof notes\n',
    },
  },
  chats: [
    { id: 'alpha', projectId, title: 'Alpha' },
    { id: 'beta', projectId, title: 'Beta' },
  ],
  runs: [],
  documentSymbols: symbols,
})
const { page, state, browser, report } = fixture
const target = page.getByLabel('Focused proof', { exact: true })
const composer = page.getByLabel('Message Lemex')
const menu = page.getByRole('dialog', {
  name: 'Choose context',
  exact: true,
})
const resultDir = path.resolve('.runtime/chat-focus-picker-ui')
await fs.mkdir(resultDir, { recursive: true })
async function openFocus() {
  await page.getByLabel('Select context', { exact: true }).click()
  await menu.waitFor()
}
async function chooseChat(id) {
  await page.getByLabel('Select chat').selectOption(id)
  await until(
    () =>
      page
        .getByRole('button', { name: 'Send', exact: true })
        .isEnabled()
        .then(() =>
          page
            .locator('.chat-picker[aria-busy="true"]')
            .count()
            .then((count) => !count),
        ),
    `chat ${id}`,
  )
}
let sent
let sendCount = 0
state.onCreateRun = ({ chat, body, respond }) => {
  sent = structuredClone(body)
  sendCount++
  const run = {
    id: `picker-sent-${sendCount}`,
    chatId: chat.id,
    projectId,
    mode: body.mode,
    prompt: body.prompt,
    proofTarget: body.proofTarget,
    files: body.files,
    liveEdits: body.liveEdits,
    status: 'completed',
    message: 'Fixture only.',
    createdAt: '2026-10-13T12:00:00Z',
  }
  if (body.mode === 'informalize') {
    const path = body.outputFile || 'Informalization.tex'
    run.message = `Review [the document](./${encodeURI(path)}#L3) and its source.`
    const markdown = path.endsWith('.md')
    const entries = (body.proofTarget ? [symbols[2]] : symbols.slice(1)).map(
      ({ name, range }) => ({
        name,
        path: 'Main.lean',
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        type: 'True',
        axioms: [],
        status: 'checked',
      }),
    )
    run.verification = {
      kind: 'workspace',
      complete: true,
      reason: 'Review the mathematical wording before applying the document.',
      informalization: {
        sources: {
          status: 'checked',
          detail: 'Lean checked the selected declarations.',
          entries,
        },
        document: { path, ...(markdown ? {} : { buildId: 'fixture-build' }) },
      },
    }
    const prose = entries
      .map(({ name, path }) =>
        [
          markdown
            ? `<!-- Lean: ${path}#${name} -->`
            : `% Lean: ${path}#${name}`,
          'The proposition is true by introduction.',
        ].join('\n'),
      )
      .join('\n\n')
    run.changes = [
      {
        path,
        before: state.files[projectId][path] ?? null,
        after: markdown
          ? `# Proof notes\n\n${prose}\n`
          : [
              '\\documentclass{article}',
              '\\begin{document}',
              prose,
              '\\end{document}',
            ].join('\n'),
      },
    ]
    if (body.liveEdits) {
      run.liveChanges = run.changes
      run.liveRevision = 1
      state.files[projectId][path] = run.changes[0].after
    }
    state.runs.push(run)
  }
  return respond(run, 202)
}
state.onApply = ({ run, respond }) => {
  assert.equal(run.status, 'completed')
  assert.equal(run.liveEdits, false)
  for (const change of run.changes)
    state.files[projectId][change.path] = change.after
  run.status = 'applied'
  return respond(run)
}
state.onUndo = ({ run, respond }) => {
  for (const change of run.liveChanges) {
    if (change.before === null) delete state.files[projectId][change.path]
    else state.files[projectId][change.path] = change.before
  }
  run.liveUndone = true
  run.liveRevision++
  return respond(run)
}
try {
  await fixture.ready()
  await until(
    () =>
      page
        .locator('.chat-picker[aria-busy="true"]')
        .count()
        .then((count) => !count),
    'initial chat loaded',
  )
  // The composer picker works with the explorer closed and needs no editor toolbar.
  await page.setViewportSize({ width: 700, height: 1000 })
  const closeSidebar = page.getByRole('button', {
    name: 'Close sidebar',
    exact: true,
  })
  if (await closeSidebar.isVisible()) await closeSidebar.click()
  await composer.fill('Please use existing lemmas.')
  assert.equal(
    await page.getByLabel('Select context', { exact: true }).count(),
    1,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Focus proof / lines', exact: true })
      .count(),
    0,
  )
  await openFocus()
  await menu.getByLabel('Filter context', { exact: true }).fill('Notes.txt')
  await menu.getByRole('checkbox', { name: 'Notes.txt', exact: true }).check()
  assert.equal(await menu.count(), 1)
  await menu.getByLabel('Filter context', { exact: true }).fill('second')
  const choice = menu
    .getByRole('list', { name: 'Proof targets in this file' })
    .getByRole('button')
  await until(
    () => choice.count().then((count) => count === 1),
    'named proof filtered',
  )
  assert.match(await choice.innerText(), /theorem/)
  await choice.click()
  await until(
    () => target.innerText().then((text) => text.includes('second')),
    'named target attached',
  )
  assert.match(await target.innerText(), /Focused on/)
  assert.match(await target.innerText(), /Main\.lean:8–9/)
  assert.equal(await composer.inputValue(), 'Please use existing lemmas.')
  assert.equal(
    await page
      .getByLabel('Selected context files')
      .innerText()
      .then((text) => text.includes('Notes.txt')),
    true,
  )
  assert.equal(
    report.requests.filter((entry) => ['POST', 'PUT'].includes(entry.method))
      .length,
    0,
  )
  report.checks.push(
    'One context control attaches files and a kind-labelled theorem with the explorer closed; the custom prompt survives and no save or send happens.',
  )

  await openFocus()
  await menu.getByLabel('Filter context', { exact: true }).fill('')
  assert.match(await menu.getByRole('list').innerText(), /def.*count/s)
  await menu.getByLabel('Lines', { exact: true }).fill('9-8')
  await menu.getByRole('button', { name: 'Use lines', exact: true }).click()
  assert.match(
    await menu.getByRole('alert').innerText(),
    /line number or range/,
  )
  await menu.getByLabel('Lines', { exact: true }).fill('2-900')
  await menu.getByRole('button', { name: 'Use lines', exact: true }).click()
  assert.match(await menu.getByRole('alert').innerText(), /file has .* lines/)
  await menu.getByLabel('Lines', { exact: true }).fill('5–6')
  await menu.getByLabel('Lines', { exact: true }).press('Enter')
  await until(
    () => target.innerText().then((text) => text.includes('Main.lean:5–6')),
    'manual line target',
  )
  assert.equal(await menu.count(), 0)
  report.checks.push(
    'Manual line ranges attach live source, Enter does not submit the chat, and reversed/out-of-file ranges are rejected without replacing the target.',
  )

  await page.setViewportSize({ width: 1600, height: 1000 })
  // Select only the proof body, not its enclosing declaration.
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentStart)
  for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press(editorShortcuts.lineStart)
  await page.keyboard.press(editorShortcuts.selectLineEnd)
  await openFocus()
  await menu.getByRole('button', { name: /Use selected lines/ }).click()
  await until(
    () => target.innerText().then((text) => /Main\.lean:6\b/.test(text)),
    'proof body selection attached',
  )
  assert.match(await target.innerText(), /Selected lines/)
  assert.doesNotMatch(await target.innerText(), /first|5–6/)
  assert.equal(
    report.requests.filter((entry) => ['POST', 'PUT'].includes(entry.method))
      .length,
    0,
  )
  report.checks.push(
    'Highlighted proof-body lines attach exactly that range through the shared selection menu, without expanding to the theorem or saving or sending.',
  )

  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentStart)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press(editorShortcuts.lineStart)
  await page.keyboard.press(editorShortcuts.selectLineEnd)
  await openFocus()
  const current = menu.getByRole('button', {
    name: /Use selected lines/,
  })
  assert.match(await current.innerText(), /count|Selected lines/)
  await current.click()
  await until(
    () => target.innerText().then((text) => text.includes('Main.lean:3')),
    'editor line selection attached',
  )
  report.checks.push(
    'A keyboard editor selection attaches from the composer without losing the saved editor selection.',
  )

  await chooseChat('beta')
  assert.equal(await target.count(), 0)
  await composer.fill('Beta instructions.')
  await openFocus()
  await menu.getByLabel('Lines', { exact: true }).fill('8-9')
  await menu.getByRole('button', { name: 'Use lines', exact: true }).click()
  await until(
    () => target.innerText().then((text) => text.includes('Main.lean:8–9')),
    'beta target',
  )
  await chooseChat('alpha')
  assert.match(await target.innerText(), /Main\.lean:3/)
  assert.equal(await composer.inputValue(), 'Please use existing lemmas.')
  await page
    .getByRole('button', { name: 'Clear proof target', exact: true })
    .click()
  assert.equal(await target.count(), 0)
  await chooseChat('beta')
  assert.match(await target.innerText(), /Main\.lean:8–9/)
  assert.equal(await composer.inputValue(), 'Beta instructions.')
  report.checks.push(
    'Targets and instructions stay with their chat; clearing one chat does not remove another chat’s target.',
  )

  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(() => !!sent, 'mock focused send')
  assert.equal(sent.proofTarget.path, 'Main.lean')
  assert.equal(sent.proofTarget.startLine, 8)
  assert.equal(sent.proofTarget.endLine, 9)
  assert.equal(sent.proofTarget.name, undefined)
  assert.equal(
    sent.proofTarget.source,
    source.split('\n').slice(7, 9).join('\n'),
  )
  await until(
    () => target.count().then((count) => count === 0),
    'sent target cleared',
  )
  assert.match(
    await page.locator('.message-proof-target').innerText(),
    /Main\.lean:8–9/,
  )
  report.checks.push(
    'Send carries exact selected source and range; the sent message keeps its visible focus label.',
  )

  // Hold autosave so the menu must use the live editor buffer.
  let releaseSave
  let allowSaves = false
  state.onSave = ({ save }) =>
    allowSaves
      ? save()
      : new Promise((resolve) => {
          releaseSave = () => resolve(save())
        })
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentStart)
  for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press(editorShortcuts.lineStart)
  await page.keyboard.press(editorShortcuts.selectLineEnd)
  await page.keyboard.insertText('exact True.intro')
  await page.keyboard.press(editorShortcuts.lineStart)
  await page.keyboard.press(editorShortcuts.selectLineEnd)
  await composer.fill('Explain just these lines.')
  await openFocus()
  await menu.getByRole('button', { name: /Use selected lines/ }).click()
  await until(
    () => target.innerText().then((text) => /Main\.lean:6\b/.test(text)),
    'unsaved lines attached',
  )
  assert.equal(state.files[projectId]['Main.lean'], source)
  assert.equal(sendCount, 1)
  allowSaves = true
  releaseSave?.()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(() => sendCount === 2, 'mock unsaved selection send')
  assert.equal(sent.proofTarget.startLine, 6)
  assert.equal(sent.proofTarget.endLine, 6)
  assert.equal(sent.proofTarget.name, undefined)
  assert.equal(sent.proofTarget.source, '  exact True.intro')
  assert.equal(sent.prompt, 'Explain just these lines.')
  report.checks.push(
    'The shared menu captures unsaved selected lines from the live editor, preserves the written prompt, and sends that exact source only when requested.',
  )

  await page.setViewportSize({ width: 390, height: 550 })
  await openFocus()
  const bounds = await menu.boundingBox()
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 391)
  assert(
    bounds.y >= 0 && bounds.y + bounds.height <= 551,
    'Focus menu must fit vertically in the viewport',
  )
  await menu.getByLabel('Lines', { exact: true }).scrollIntoViewIfNeeded()
  await menu.getByLabel('Lines', { exact: true }).fill('5-6')
  await menu
    .getByRole('button', { name: 'Use lines', exact: true })
    .click({ trial: true })
  await menu.getByLabel('Lines', { exact: true }).press('Escape')
  assert.equal(await menu.count(), 0)
  assert.equal(
    await page
      .getByLabel('Select context', { exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  )
  report.checks.push(
    'Focus menu is usable at 390×550; Escape dismisses it and restores keyboard focus.',
  )
  await page.setViewportSize({ width: 844, height: 390 })
  const options = page.locator('.chat-options')
  const optionsToggle = options.locator('summary')
  for (const expanded of [false, true]) {
    const alreadyExpanded = (await options.getAttribute('open')) !== null
    if (alreadyExpanded !== expanded) await optionsToggle.click()
    const trigger = page.getByLabel('Select context', { exact: true })
    await trigger.scrollIntoViewIfNeeded()
    const before = await page
      .locator('.chat-workbench')
      .evaluate((node) => node.scrollTop)
    const transcriptBefore = await page
      .locator('.assistant-conversation')
      .evaluate((node) => node.scrollTop)
    await openFocus()
    assert.equal(
      await menu.evaluate((node) => node.parentElement === document.body),
      true,
    )
    const popupBounds = await menu.boundingBox()
    assert(popupBounds.x >= 0 && popupBounds.x + popupBounds.width <= 845)
    assert(popupBounds.y >= 0 && popupBounds.y + popupBounds.height <= 391)
    for (const visible of [
      menu.locator('.chat-focus-heading'),
      menu.getByLabel('Filter context', { exact: true }),
    ]) {
      assert.equal(
        await visible.evaluate((node) => {
          const box = node.getBoundingClientRect()
          const hit = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          )
          return hit === node || node.contains(hit)
        }),
        true,
        `Menu heading/search is clipped with Options ${expanded ? 'open' : 'closed'}`,
      )
    }
    await menu
      .getByLabel('Filter context', { exact: true })
      .click({ trial: true })
    assert.equal(
      await page.locator('.chat-workbench').evaluate((node) => node.scrollTop),
      before,
      'Opening focus menu moved the chat viewport',
    )
    assert.equal(
      await page
        .locator('.assistant-conversation')
        .evaluate((node) => node.scrollTop),
      transcriptBefore,
      'Opening focus menu moved the transcript',
    )
    await menu.getByLabel('Lines', { exact: true }).scrollIntoViewIfNeeded()
    await menu.getByLabel('Lines', { exact: true }).fill('5-6')
    await menu
      .getByRole('button', { name: 'Use lines', exact: true })
      .click({ trial: true })
    await menu.getByLabel('Lines', { exact: true }).press('Escape')
    assert.equal(await menu.count(), 0)
    assert.equal(
      await page
        .locator('.assistant-conversation')
        .evaluate((node) => node.scrollTop),
      transcriptBefore,
      'Scrolling focus menu moved the transcript',
    )
  }
  report.checks.push(
    'At 844×390 with Options open and closed, the portal menu fits the viewport, heading/search receive pointer input, Use lines is reachable by scrolling the menu, and the transcript stays still.',
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.screenshot({
    path: path.join(resultDir, 'focused-composer.png'),
    fullPage: true,
  })

  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  const modes = page.getByLabel('Assistant mode', { exact: true })
  const informalize = modes.getByRole('button', {
    name: 'Informalize',
    exact: true,
  })
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await informalize.click()
  const liveEdits = options.getByRole('checkbox', {
    name: 'Edit files live',
    exact: true,
  })
  assert.equal(await liveEdits.isChecked(), true)
  await page
    .getByRole('button', { name: 'Write an informal proof', exact: true })
    .click()
  const destination = page.getByLabel('Output document (optional)', {
    exact: true,
  })
  await page
    .getByText('Using the open file · Main.lean', { exact: true })
    .waitFor()
  const resize = page.getByRole('separator', { name: 'Resize assistant panel' })
  const rail = await resize.boundingBox()
  const from = rail.x + rail.width / 2
  const middle = rail.y + rail.height / 2
  const oldWidth = Number(await resize.getAttribute('aria-valuenow'))
  await page.mouse.move(from, middle)
  await page.mouse.down()
  await page.mouse.move(from + oldWidth - 550, middle)
  await page.mouse.up()
  await until(
    () => resize.getAttribute('aria-valuenow').then((value) => value === '550'),
    '550px assistant panel',
  )
  for (const viewport of [
    { width: 1600, height: 800 },
    { width: 390, height: 550 },
  ]) {
    await page.setViewportSize(viewport)
    await destination.fill('Problem1_16.tex')
    await send.scrollIntoViewIfNeeded()
    const gaps = await destination.evaluate((field) => {
      const box = field.getBoundingClientRect()
      const style = getComputedStyle(field)
      const outline =
        parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
      const source = field.form
        .querySelector('.composer-context')
        .getBoundingClientRect()
      const message = field.form
        .querySelector('textarea')
        .getBoundingClientRect()
      return {
        focused: document.activeElement === field,
        above: box.top - outline - source.bottom,
        below: message.top - box.bottom - outline,
      }
    })
    assert.ok(gaps.focused)
    assert.ok(
      gaps.above >= 1 && gaps.below >= 1,
      `Focused output field overlaps its neighbours at ${viewport.width}px: ${JSON.stringify(gaps)}`,
    )
    await composer.click({ trial: true })
    await send.click({ trial: true })
    if (viewport.width === 1600)
      await page
        .locator('.assistant-composer')
        .screenshot({ path: path.join(resultDir, 'informalize-composer.png') })
  }
  report.checks.push(
    'With a 550px chat panel and on a 390px phone, the focused output field clears the source line and message box, and the prompt and Send are reachable.',
  )
  await destination.fill('')
  await page.setViewportSize({ width: 1600, height: 1000 })
  await send.click()
  await until(() => sendCount === 3, 'whole-file informalization')
  assert.equal(sent.mode, 'informalize')
  assert.equal(sent.file, 'Main.lean')
  assert.equal(sent.currentFile, 'Main.lean')
  assert.deepEqual(sent.files, [])
  assert.equal(sent.proofTarget, undefined)
  assert.equal(sent.outputFile, undefined)
  assert.equal(sent.liveEdits, true)
  assert.match(sent.prompt, /each theorem and its proof/i)
  await until(
    () => composer.inputValue().then((value) => value === ''),
    'translation submitted',
  )
  report.checks.push(
    'The default document request includes the current Lean file and proof arguments, and leaves the destination open to the user’s prompt.',
  )
  const texTurn = page.locator('[data-run-id="picker-sent-3"]')
  const checks = texTurn.getByRole('region', { name: 'Informalization checks' })
  await checks.getByText('Lean checked 2 proofs.').click()
  await checks.getByRole('button', { name: /first · Main\.lean:5–6/ }).waitFor()
  assert.match(await checks.innerText(), /Informalization.tex · PDF built/)
  const pdf = checks.getByRole('link', { name: 'Open PDF', exact: true })
  const pdfURL = new URL(await pdf.getAttribute('href'), page.url())
  assert.equal(
    pdfURL.pathname,
    `/api/projects/${projectId}/tex/builds/fixture-build/pdf`,
  )
  assert.equal(pdfURL.searchParams.get('expectedUserId'), 'focus-picker-owner')
  assert.equal(
    await checks
      .getByRole('link', { name: 'Download PDF', exact: true })
      .getAttribute('download'),
    'Informalization.pdf',
  )
  await checks.getByText('Document saved', { exact: true }).waitFor()
  assert.equal(await checks.getByText(/before applying/).count(), 0)
  await page.route(
    (url) => url.pathname === `/api/projects/${projectId}/tex`,
    (route) =>
      route.fulfill({
        json: {
          available: true,
          engines: ['pdflatex'],
          workspaceRevision: null,
          build: null,
          lastSuccessful: null,
        },
      }),
  )
  await texTurn.getByRole('link', { name: 'the document', exact: true }).click()
  await page
    .getByRole('tab', {
      name: 'Informalization.tex',
      selected: true,
      exact: true,
    })
    .waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  await texTurn.getByRole('button', { name: /View edits/ }).click()
  const savedReview = page.getByRole('dialog', { name: 'Review saved edits' })
  await savedReview.getByText(/documentclass/).waitFor()
  assert.equal(
    await savedReview
      .getByRole('button', { name: 'Apply changes', exact: true })
      .count(),
    0,
  )
  await savedReview.getByText('Lean checked 2 proofs.').click()
  await savedReview
    .getByRole('button', { name: /first · Main\.lean:5–6/ })
    .click()
  await savedReview.waitFor({ state: 'hidden' })
  await openFocus()
  await menu
    .getByRole('button', { name: /Use selected lines.*lines 5–6/ })
    .waitFor()
  await menu.getByLabel('Filter context', { exact: true }).press('Escape')
  await texTurn.getByRole('button', { name: 'Undo agent edits' }).click()
  await texTurn.getByText('Edits undone', { exact: true }).waitFor()
  assert.equal(state.files[projectId]['Informalization.tex'], undefined)
  assert.equal(
    await checks.getByRole('button', { name: 'Open document' }).count(),
    0,
  )
  assert.equal(await checks.getByText(/before applying/).count(), 0)
  report.checks.push(
    'The checked paper saves automatically. Its chat link opens the saved file, View edits shows its diff and source lines, and Undo removes the new file.',
  )

  await modes.getByRole('button', { name: 'Proofs', exact: true }).click()
  assert.equal(await liveEdits.isEnabled(), true)
  const outline = page.getByRole('region', { name: 'File outline' })
  await outline
    .locator('.proof-outline-entry')
    .filter({ hasText: 'second' })
    .click()
  await outline
    .getByRole('button', { name: 'Informalize', exact: true })
    .click()
  await until(
    () =>
      informalize
        .getAttribute('aria-pressed')
        .then((value) => value === 'true'),
    'outline selected Informalize',
  )
  assert.match(await target.innerText(), /second/)
  assert.match(await composer.inputValue(), /mathematical English/i)
  if ((await options.getAttribute('open')) === null) await optionsToggle.click()
  await liveEdits.uncheck()
  await page.getByLabel('Output document').fill('Notes.md')
  await send.click()
  await until(() => sendCount === 4, 'focused informalization')
  assert.equal(sent.mode, 'informalize')
  assert.equal(sent.liveEdits, false)
  assert.equal(sent.outputFile, 'Notes.md')
  assert.deepEqual(sent.proofTarget, {
    path: 'Main.lean',
    name: 'second',
    startLine: 8,
    endLine: 9,
    source: source.split('\n').slice(7, 9).join('\n'),
  })
  report.checks.push(
    'Informalize in Outline switches the chat mode and sends the named theorem with its exact Lean source.',
  )
  const markdownTurn = page.locator('[data-run-id="picker-sent-4"]')
  await markdownTurn.getByText('Notes.md · Markdown').waitFor()
  assert.equal(
    await markdownTurn.getByRole('link', { name: 'Open PDF' }).count(),
    0,
  )
  const markdownLink = markdownTurn.getByRole('link', {
    name: 'the document',
    exact: true,
  })
  await markdownLink.click()
  const review = page.getByRole('dialog', { name: 'Review document' })
  await review.getByText(/The proposition is true by introduction/).waitFor()
  await review
    .getByRole('button', { name: 'Apply changes', exact: true })
    .click()
  await markdownTurn.getByRole('button', { name: 'Open document' }).waitFor()
  assert.match(state.files[projectId]['Notes.md'], /The proposition is true/)
  assert.equal(
    await markdownTurn
      .getByRole('button', { name: 'Download project file' })
      .count(),
    1,
  )
  await markdownLink.click()
  await page
    .getByRole('tab', { name: 'Notes.md', selected: true, exact: true })
    .waitFor()
  assert.equal(await review.count(), 0)
  const markdownEditor = page.locator('.monaco-editor .view-lines')
  await until(
    async () =>
      (await markdownEditor.innerText())
        .replace(/\u00a0/g, ' ')
        .includes('The proposition is true by introduction.'),
    'saved document opened from the assistant reply',
  )
  await page.getByRole('tab', { name: 'Main.lean', exact: true }).click()
  report.checks.push(
    'The same chat link opens the proposed Markdown diff before Apply and the saved, updated Markdown text after Apply and history reload.',
  )
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await informalize.click()
  await openFocus()
  await menu.getByRole('checkbox', { name: 'Other.lean', exact: true }).check()
  await menu.getByLabel('Filter context', { exact: true }).press('Escape')
  await page.getByLabel('Output document').fill('First draft.tex')
  await composer.fill('Document the attached theorem.')
  let running
  state.onCreateRun = ({ chat, body, respond }) => {
    assert.equal(body.file, 'Other.lean')
    assert.deepEqual(body.files, ['Other.lean'])
    assert.equal(body.currentFile, 'Main.lean')
    assert.equal(body.outputFile, 'First draft.tex')
    running = {
      id: 'running-document',
      chatId: chat.id,
      projectId,
      mode: body.mode,
      liveEdits: false,
      status: 'running',
      prompt: body.prompt,
      message: '',
      createdAt: new Date().toISOString(),
    }
    state.runs.push(running)
    return respond(running, 202)
  }
  state.onMessage = async ({ run, body, respond }) => {
    assert.equal(body.outputFile, undefined)
    const receipt = {
      id: body.id,
      text: body.text,
      status: 'accepted',
      createdAt: new Date().toISOString(),
      messageOffset: run.message.length,
    }
    await fixture.emit(run, 'followup', receipt)
    return respond(run)
  }
  state.onStop = async ({ run, respond }) => {
    await fixture.emit(run, 'status', { status: 'cancelled' })
    return respond(run)
  }
  await send.click()
  const runningTurn = page.locator('[data-run-id="running-document"]')
  const sendUpdate = page.getByRole('button', {
    name: 'Send update',
    exact: true,
  })
  await sendUpdate.waitFor()
  await fixture.emit(running, 'message', 'Preparing the document.')
  await runningTurn
    .getByText('Preparing the document.', { exact: true })
    .waitFor()
  await composer.fill('Call the quantity the total.')
  await sendUpdate.click()
  await runningTurn.getByText('Update accepted', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await runningTurn.getByText('Stopped', { exact: true }).waitFor()
  assert.equal(
    await runningTurn.getByRole('button', { name: /Review document/ }).count(),
    0,
  )
  report.checks.push(
    'An explicit Lean attachment takes precedence over the open tab. The same document run streams replies, accepts a follow-up without a new output target, and stops without applying files.',
  )
  fixture.assertClean()
  report.passed = true
  console.log(
    `PASS: ${report.checks.length} focused composer checks; APIs mocked`,
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
  report.pageText = await page
    .locator('body')
    .innerText()
    .catch(() => '')
  await page
    .screenshot({ path: path.join(resultDir, 'failure.png'), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(resultDir, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
