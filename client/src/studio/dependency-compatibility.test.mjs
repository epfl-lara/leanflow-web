import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const manifest = (file) => JSON.parse(readFileSync(file, 'utf8'))

test('Markdown math integrations use the same patched KaTeX as the client', () => {
  const client = manifest(new URL('../../package.json', import.meta.url))
  const root = manifest(new URL('../../../package.json', import.meta.url))
  assert.equal(root.overrides.katex, client.dependencies.katex)
  const expected = manifest(require.resolve('katex/package.json')).version
  for (const integration of ['rehype-katex', 'micromark-extension-math']) {
    const resolveFromIntegration = createRequire(require.resolve(integration))
    const actual = manifest(
      resolveFromIntegration.resolve('katex/package.json'),
    ).version
    assert.equal(
      actual,
      expected,
      `${integration} must respect the KaTeX override`,
    )
  }
})

test('Lean editor extensions use the same service version as its editor API', () => {
  const root = new URL('../../../node_modules/', import.meta.url)
  const expected = manifest(new URL('monaco-editor/package.json', root)).version
  for (const extension of [
    'bulk-edit-service-override',
    'latex-default-extension',
    'markdown-basics-default-extension',
  ]) {
    const actual = manifest(
      new URL(`@codingame/monaco-vscode-${extension}/package.json`, root),
    ).version
    assert.equal(actual, expected, `${extension} must match Lean's editor API`)
  }
})
