#!/usr/bin/env node
// Search-only browser checks: API, workspace, Lean, and providers are fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chatBrowserFixture,
  until,
  sleep,
} from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.runtime/search-results-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'search-ui-project'
const otherProjectId = 'search-ui-other-project'
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { available: true },
  },
  projects: [
    { id: projectId, name: 'Search fixture', status: 'ready' },
    { id: otherProjectId, name: 'Other search fixture', status: 'ready' },
  ],
  files: {
    [projectId]: { 'Main.lean': 'example : True := by trivial\n' },
    [otherProjectId]: { 'Main.lean': 'example : True := by trivial\n' },
  },
  chats: [{ id: 'search-ui-chat', projectId, title: 'Fixture chat' }],
  runs: [],
})
const { page, browser, report } = fixture
const type =
  '{α : Type u} [Preorder α] (f : ℕ → α) (h : Monotone f)\n' +
  '  (bounded : ∀ n, f n ≤ f (n + 1)) : ∀ m n, m ≤ n → f m ≤ f n'
const longType =
  '(f : Very.Long.' + 'Namespace'.repeat(15) + '.Function) : ∀ n : ℕ, f n = f n'
const signature =
  'theorem List.map_id {α : Type u} (xs : List α) : xs.map id = xs'
const documentation = [
  "**Darboux's theorem**: the image of a convex set under `f'` is a convex set, `deriv` version.",
  '',
  String.raw`The force $f(x,t)$ is smooth ($C^\infty$) for $t \ge 0$. Also \(a^2+b^2=c^2\).`,
  '',
  '$$',
  String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`,
  '$$',
  '',
  String.raw`\[\underbrace{x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x}_{\text{a long equation}}\]`,
  '',
  '- A monotone function preserves the order.',
  '- [Lean reference](https://lean-lang.org/)',
  '',
  '| Version | Declaration |',
  '| --- | --- |',
  '| Derivative | `Convex.image_deriv` |',
  '',
  '```lean',
  'example : True := by trivial',
  '```',
  '',
  '![diagram](https://example.com/search-image.png)',
  '[Unsafe link](javascript:alert%281%29)',
  '<img src=x onerror=alert(1)>',
  '<script>window.__searchInjected = true</script>',
].join('\n')
const explore = {
  source: { name: 'LeanExplore', version: 'Fixture index' },
  results: [
    {
      name: 'Monotone.map_le',
      type,
      signature: type,
      kind: 'theorem',
      doc: documentation,
      module: 'Mathlib.Order.Monotone.Basic',
      url: 'https://leanprover-community.github.io/mathlib4_docs/Mathlib/Order/Monotone/Basic.html',
    },
    { name: 'List.map_id', type: '', signature, kind: 'theorem' },
    {
      name: 'Missing.type',
      type: '',
      doc: 'This is documentation, not a Lean type.',
      url: 'javascript:alert(1)',
    },
    {
      name: 'Long.signature',
      type: longType,
      kind: 'def',
      url: 'https://hidden-token@example.com/source',
    },
  ],
}
const loogle = {
  source: { name: 'Loogle', version: 'Fixture index' },
  results: [
    {
      name: 'Nat.add_comm',
      type: '∀ (n m : ℕ), n + m = m + n',
      module: 'Init.Data.Nat.Lemmas',
      url: 'https://leanprover-community.github.io/mathlib4_docs/Init/Data/Nat/Lemmas.html',
    },
    {
      name: 'Legacy.documentation_only',
      description: 'Legacy prose must stay in documentation.',
      type: { unexpected: 'object' },
    },
  ],
}
const pending = new Map()
// Also test generation guards when cancellation is ignored by a transport.
await page.addInitScript(() => {
  const fetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    if (String(input).includes('/api/search') && init?.signal) {
      const { signal: _signal, ...uncancellable } = init
      return fetch(input, uncancellable)
    }
    return fetch(input, init)
  }
})
await page.route('**/api/search', async (route) => {
  const body = route.request().postDataJSON()
  report.requests.push({ method: 'POST', endpoint: '/api/search', body })
  const respond = (value, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    })
  if (body.query.startsWith('slow-')) {
    return new Promise((resolve) => {
      pending.set(body.query, async (value, status = 200) => {
        await respond(value, status)
        resolve()
      })
    })
  }
  return respond(body.backend === 'leanexplore' ? explore : loogle)
})
const engine = page.getByLabel('Search engine')
const query = page.locator('#declaration-query')
const search = page.getByRole('button', {
  name: 'Search declarations',
  exact: true,
})
const card = (name) =>
  page
    .locator('.search-result')
    .filter({ has: page.getByText(name, { exact: true }) })
async function submit(text) {
  await query.fill(text)
  await search.click()
}
async function checkTypes(theme) {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value
  }, theme)
  await until(
    async () => (await card('Monotone.map_le').count()) === 1,
    'LeanExplore result',
  )
  assert.equal(
    await card('Monotone.map_le').locator('.search-type').innerText(),
    type,
  )
  assert.equal(
    await card('List.map_id').locator('.search-type').innerText(),
    signature,
  )
  assert.equal(
    await card('List.map_id').locator('.search-result-label').innerText(),
    'Signature',
  )
  assert.equal(
    await card('Monotone.map_le').locator('.search-kind').innerText(),
    'theorem',
  )
  assert.equal(
    await card('Long.signature').locator('.search-kind').innerText(),
    'def',
  )
  assert.equal(await card('Missing.type').locator('.search-type').count(), 0)
  assert.match(await card('Missing.type').innerText(), /Type unavailable/)
  assert.equal(await page.locator('.search-result img').count(), 0)
  assert.equal(await page.locator('.search-result script').count(), 0)
  assert.equal(await page.evaluate(() => window.__searchInjected), undefined)
  assert.equal(await card('Missing.type').getByRole('link').count(), 0)
  assert.equal(await card('Long.signature').getByRole('link').count(), 0)
  assert.equal(
    await card('Monotone.map_le')
      .getByRole('link', { name: 'Open source' })
      .getAttribute('rel'),
    'noopener noreferrer',
  )
  const docs = card('Monotone.map_le').locator('.search-documentation-body')
  assert.equal(await docs.locator('.katex').count(), 6)
  assert.equal(await docs.locator('.katex-display').count(), 2)
  assert.equal(await docs.locator('math').count(), 6)
  assert.equal(await docs.locator('.katex-error').count(), 0)
  await page.evaluate(() => document.fonts.ready)
  const mathStyle = await docs
    .locator('.katex .mathnormal')
    .first()
    .evaluate((element) => ({
      font: getComputedStyle(element).fontFamily,
      height: element.getBoundingClientRect().height,
    }))
  assert.match(mathStyle.font, /KaTeX/)
  assert(mathStyle.height > 0)
  for (const display of await docs.locator('.katex-display').all()) {
    assert.equal(
      await display.evaluate((element) => getComputedStyle(element).overflowX),
      'auto',
    )
  }
  assert.equal(await docs.locator('strong').innerText(), "Darboux's theorem")
  assert.equal(await docs.locator('p > code').nth(0).innerText(), "f'")
  assert.equal(await docs.locator('p > code').nth(1).innerText(), 'deriv')
  assert.equal(await docs.locator('ul > li').count(), 2)
  assert.equal(await docs.locator('table th').count(), 2)
  assert.equal(
    await docs.locator('table td code').innerText(),
    'Convex.image_deriv',
  )
  assert.equal(
    await docs.locator('pre > code.language-lean').innerText(),
    'example : True := by trivial\n',
  )
  const reference = docs.getByRole('link', { name: 'Lean reference' })
  assert.equal(await reference.getAttribute('href'), 'https://lean-lang.org/')
  assert.equal(await reference.getAttribute('target'), '_blank')
  assert.equal(await reference.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(
    await docs.getByText('Unsafe link', { exact: true }).getAttribute('href'),
    '',
  )
  assert.equal(
    await docs
      .getByRole('link', { name: 'Image: diagram' })
      .getAttribute('href'),
    'https://example.com/search-image.png',
  )
  const docStyle = await docs.evaluate((element) => {
    const bold = element.querySelector('strong')
    const link = element.querySelector('li a')
    return {
      color: getComputedStyle(element).color,
      boldColor: getComputedStyle(bold).color,
      font: getComputedStyle(element).fontFamily,
      boldFont: getComputedStyle(bold).fontFamily,
      linkDisplay: getComputedStyle(link).display,
      linkMargin: getComputedStyle(link).marginTop,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }
  })
  assert.equal(docStyle.boldColor, docStyle.color)
  assert.equal(docStyle.boldFont, docStyle.font)
  assert.equal(docStyle.linkDisplay, 'inline')
  assert.equal(docStyle.linkMargin, '0px')
  assert(docStyle.scrollWidth <= docStyle.width + 1, JSON.stringify(docStyle))
  for (const name of ['Monotone.map_le', 'Long.signature']) {
    const style = await card(name)
      .locator('.search-type')
      .evaluate((element) => {
        const css = getComputedStyle(element)
        return {
          whiteSpace: css.whiteSpace,
          overflowWrap: css.overflowWrap,
          fontSize: css.fontSize,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
          color: css.color,
          background: css.backgroundColor,
        }
      })
    assert.equal(style.whiteSpace, 'pre-wrap')
    assert.equal(style.overflowWrap, 'anywhere')
    assert(style.scrollWidth <= style.width + 1, JSON.stringify(style))
    const luminance = (color) => {
      const rgb = color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const v = value / 255
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
        })
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    }
    const fg = luminance(style.color),
      bg = luminance(style.background)
    assert((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) >= 4.5)
  }
  await page.screenshot({ path: path.join(output, `search-${theme}.png`) })
  report.checks.push(
    `${theme}: readable types and Markdown docs, inline/display math with local fonts, contained wide equations, literal Lean code, lists, tables, wrapping, contrast, safe links and no injected HTML`,
  )
}
try {
  await fixture.ready()
  await page.getByRole('tab', { name: 'Search', exact: true }).click()
  assert.equal(await engine.inputValue(), 'leanexplore')
  await submit('monotone')
  await checkTypes('dark')
  await checkTypes('light')
  await engine.selectOption('loogle')
  assert.equal(await page.locator('.search-result').count(), 0)
  assert.equal(await query.getAttribute('placeholder'), 'List.map, (_ → _)')
  await submit('Nat.add_comm')
  await until(
    async () => (await card('Nat.add_comm').count()) === 1,
    'Loogle result',
  )
  assert.equal(
    await card('Nat.add_comm').locator('.search-type').innerText(),
    '∀ (n m : ℕ), n + m = m + n',
  )
  assert.equal(
    await card('Legacy.documentation_only').locator('.search-type').count(),
    0,
  )
  assert.equal(
    await card('Legacy.documentation_only')
      .locator('.search-documentation p')
      .innerText(),
    'Legacy prose must stay in documentation.',
  )
  report.checks.push(
    'Loogle type patterns preserved; legacy prose is not a type',
  )

  await submit('slow-engine')
  await until(() => pending.has('slow-engine'), 'pending engine search')
  await engine.selectOption('leanexplore')
  await pending.get('slow-engine')({
    results: [{ name: 'Stale.engine', type: 'False' }],
  })
  await sleep(150)
  assert.equal(await page.locator('.search-result').count(), 0)
  assert.equal(await search.isEnabled(), true)
  report.checks.push(
    'Switching engine discards stale results and resets busy state',
  )

  await submit('slow-earlier-query')
  await until(() => pending.has('slow-earlier-query'), 'pending earlier query')
  await submit('newer-query')
  await until(
    async () => (await card('Monotone.map_le').count()) === 1,
    'newer result',
  )
  await pending.get('slow-earlier-query')({
    results: [{ name: 'Stale.query', type: 'False' }],
  })
  await sleep(150)
  assert.equal(await card('Monotone.map_le').count(), 1)
  assert.equal(await card('Stale.query').count(), 0)
  assert.equal(
    await page.locator('.search-panel').getByRole('alert').count(),
    0,
  )
  report.checks.push(
    'Newer query supersedes prior request even when cancellation is ignored',
  )

  await submit('slow-project')
  await until(() => pending.has('slow-project'), 'pending project search')
  await page.locator('.project-item[title="Other search fixture"]').click()
  await until(
    async () =>
      (await page.locator('.project-item.selected').innerText()).includes(
        'Other search fixture',
      ),
    'project switch',
  )
  await pending.get('slow-project')({ error: 'Stale project error.' }, 502)
  await sleep(150)
  assert.equal(await page.locator('.search-result').count(), 0)
  assert.equal(
    await page.locator('.search-panel').getByRole('alert').count(),
    0,
  )
  assert.equal(await search.isEnabled(), true)
  await submit('other-project')
  await until(
    async () => (await card('Monotone.map_le').count()) === 1,
    'other project result',
  )
  assert.equal(
    report.requests
      .filter((request) => request.endpoint === '/api/search')
      .at(-1).body.projectId,
    otherProjectId,
  )
  report.checks.push(
    'Project switch discards old results/errors and uses current workspace',
  )
  fixture.assertClean()
  report.ok = true
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
}
console.log(
  JSON.stringify({ ok: report.ok, checks: report.checks, output }, null, 2),
)
