#!/usr/bin/env node
// Render the actual Lean grammar and semantic tokens with isolated API fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/editor-theme-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const projectId = 'editor-theme-project'
const source = `namespace Basics

/-- A simple identity over the natural numbers. -/
def identity (n : Nat) : Nat := n

-- A comment before the proof.
theorem add_zero (n : Nat) : n + 0 = n := by
  exact Nat.add_zero n

def successor (n : Nat) : Nat := n.succ
def greeting : String := "Hello, Lean."

example : True := by
  sorry

end Basics
`
const lines = source.split('\n')
const tokenTypes = [
  'keyword',
  'variable',
  'property',
  'function',
  'leanSorryLike',
]
const tokens = []
for (const [line, text] of lines.entries()) {
  if (text.startsWith('--') || text.startsWith('/--')) continue
  for (const match of text.matchAll(
    /\b(namespace|def|theorem|by|exact|example|end|n|succ|sorry|identity)\b/g,
  )) {
    const type =
      match[0] === 'n'
        ? 'variable'
        : match[0] === 'succ'
          ? 'property'
          : match[0] === 'sorry'
            ? 'leanSorryLike'
            : match[0] === 'identity'
              ? 'function'
              : 'keyword'
    tokens.push({ line, start: match.index, length: match[0].length, type })
  }
}
let previousLine = 0
let previousStart = 0
const data = tokens.flatMap(({ line, start, length, type }) => {
  const encoded = [
    line - previousLine,
    start - (line === previousLine ? previousStart : 0),
    length,
    tokenTypes.indexOf(type),
    0,
  ]
  previousLine = line
  previousStart = start
  return encoded
})
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'theme-owner', name: 'Theme fixture', role: 'user' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [{ id: projectId, name: 'Lean essentials', status: 'ready' }],
  files: { [projectId]: { 'Main.lean': source } },
  chats: [{ id: 'theme-chat', projectId, title: 'Reading Lean', runCount: 0 }],
  runs: [],
  semanticTokens: { legend: { tokenTypes, tokenModifiers: [] }, data },
})
const { page, browser, report } = fixture
let semanticRequests = 0
fixture.state.onLeanMessage = (message) => {
  if (message.method === 'textDocument/semanticTokens/full') semanticRequests++
}

async function samples() {
  return page.locator('.monaco-editor').evaluate((editor) => {
    const normalize = (text) => text.replaceAll('\u00a0', ' ')
    const read = (lineStart, needle, skip = 0) => {
      const line = [...editor.querySelectorAll('.view-line')].find((line) =>
        normalize(line.textContent).trimStart().startsWith(lineStart),
      )
      if (!line) return null
      let offset = normalize(line.textContent).indexOf(needle)
      if (offset < 0) return null
      offset += skip
      for (const span of line.querySelectorAll('span')) {
        if (span.querySelector('span')) continue
        if (offset < span.textContent.length) {
          const style = getComputedStyle(span)
          return {
            color: style.color,
            weight: style.fontWeight,
            italic: style.fontStyle,
            synthesis: style.fontSynthesis,
          }
        }
        offset -= span.textContent.length
      }
      return null
    }
    const style = getComputedStyle(editor)
    return {
      background: style.backgroundColor,
      lineHighlight: style
        .getPropertyValue('--vscode-editor-lineHighlightBackground')
        .trim(),
      selection: style
        .getPropertyValue('--vscode-editor-selectionBackground')
        .trim(),
      keyword: read('def identity', 'def'),
      name: read('def identity', 'identity'),
      type: read('def identity', 'Nat'),
      local: read('def identity', 'n : Nat'),
      tactic: read('exact Nat.', 'exact'),
      projection: read('def successor', '.succ', 1),
      comment: read('-- A comment', '--'),
      documentation: read('/-- A simple', '/--'),
      number: read('theorem add_zero', '0'),
      string: read('def greeting', 'Hello, Lean.'),
      sorry: read('sorry', 'sorry'),
      lineNumber: {
        color: getComputedStyle(
          editor.querySelector('.line-numbers:not(.active-line-number)'),
        ).color,
      },
    }
  })
}

function rgba(color) {
  if (color === 'transparent') return [0, 0, 0, 0]
  if (!color.startsWith('#')) return color.match(/[\d.]+/g).map(Number)
  const channels = color
    .slice(1)
    .match(/../g)
    .map((part) => parseInt(part, 16))
  return [...channels.slice(0, 3), (channels[3] ?? 255) / 255]
}
function background(color, canvas) {
  const front = rgba(color)
  const alpha = front[3] ?? 1
  const back = rgba(canvas)
  return `rgb(${front
    .slice(0, 3)
    .map((channel, index) => channel * alpha + back[index] * (1 - alpha))
    .join(', ')})`
}
function luminance(color) {
  return rgba(color)
    .slice(0, 3)
    .map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    .reduce(
      (sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index],
      0,
    )
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}
async function checkTheme(theme) {
  await until(async () => {
    const value = await samples()
    return (
      value.local &&
      value.type &&
      value.tactic &&
      value.local.color !== value.type.color &&
      value.keyword.color !== value.type.color &&
      value.tactic.color === value.keyword.color &&
      (theme === 'dark'
        ? luminance(value.background) < 0.1
        : luminance(value.background) > 0.9)
    )
  }, `${theme} syntax and semantic palette`)
  const value = await samples()
  assert(semanticRequests > 0, 'The editor must request Lean semantic tokens')
  assert.notEqual(value.keyword.color, value.type.color)
  assert.notEqual(value.name.color, value.type.color)
  assert.equal(value.tactic.color, value.keyword.color)
  assert.equal(
    value.keyword.weight,
    '400',
    'Ordinary keywords should use the standard theme typography',
  )
  assert.equal(value.comment.italic, 'normal')
  assert.equal(value.documentation.italic, 'normal')
  assert.notEqual(
    value.sorry.color,
    value.keyword.color,
    'Incomplete proofs must stay distinct',
  )
  assert.equal(value.sorry.italic, 'italic')
  assert(
    value.sorry.synthesis.includes('style'),
    'The regular-only code font must visibly render theme emphasis',
  )
  assert.notEqual(value.projection.color, value.type.color)
  assert.notEqual(value.projection.color, value.local.color)
  for (const [name, token] of Object.entries(value)) {
    if (typeof token === 'string') continue
    assert(token, `Missing ${name} token`)
    const minimum = name === 'lineNumber' ? 3 : 4.5
    assert(
      contrast(token.color, value.background) >= minimum,
      `${theme} ${name} contrast on the editor canvas`,
    )
    if (name === 'lineNumber') continue
    // Retain the standard theme's muted overlays; ensure text remains legible
    // when an active line or selection is composited over its editor canvas.
    const surfaces = [
      background(value.lineHighlight, value.background),
      background(value.selection, value.background),
    ]
    for (const surface of surfaces) {
      const ratio = contrast(token.color, surface)
      assert(
        ratio >= 3,
        `${theme} ${name} contrast on ${surface}: ${ratio.toFixed(2)}`,
      )
    }
  }
  const frame = page.frameLocator('.infoview-host iframe')
  await until(
    async () =>
      (await frame
        .locator('body')
        .evaluate((body) => getComputedStyle(body).backgroundColor)) ===
      value.background,
    `${theme} proof panel surface`,
  )
  report.palettes ??= []
  report.palettes.push({ theme, ...value })
  await page.screenshot({
    path: new URL(`github-${theme}.png`, directory).pathname,
  })
  const sourcePane = await page.locator('.source-pane').boundingBox()
  assert(sourcePane)
  await page.screenshot({
    path: new URL(`github-${theme}-editor.png`, directory).pathname,
    clip: { ...sourcePane, height: Math.min(sourcePane.height, 360) },
  })
}

try {
  await fixture.ready()
  const editor = await page.locator('.monaco-editor').elementHandle()
  const composer = page.getByLabel('Message Lemex')
  await composer.fill('Explain why adding zero leaves n unchanged.')
  await checkTheme('dark')
  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  await checkTheme('light')
  await page
    .getByRole('button', { name: 'Use dark theme', exact: true })
    .click()
  await checkTheme('dark')
  assert.equal(
    await editor.evaluate(
      (element) => element === document.querySelector('.monaco-editor'),
    ),
    true,
    'Changing themes must preserve the editor instance',
  )
  assert.equal(
    await composer.inputValue(),
    'Explain why adding zero leaves n unchanged.',
  )
  assert.equal(fixture.state.files[projectId]['Main.lean'], source)
  assert.equal(
    report.sockets.length,
    1,
    'Changing themes must preserve the Lean connection',
  )
  assert.equal(
    report.requests.filter(
      (request) => !['GET', 'LSP'].includes(request.method),
    ).length,
    0,
    'Theme changes must not save or modify source files',
  )
  report.checks.push(
    'Both standard GitHub themes retain readable syntax and semantic tokens, regular-weight keywords, neutral comments and distinct local variables, projections and incomplete proofs.',
  )
  report.checks.push(
    'Theme switching updates the proof panel and preserves the editor, Lean connection, source and assistant draft.',
  )
  fixture.assertClean()
  console.log(JSON.stringify(report, null, 2))
} finally {
  await fs.writeFile(
    new URL('report.json', directory),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
