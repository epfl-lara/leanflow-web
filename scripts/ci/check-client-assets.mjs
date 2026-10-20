#!/usr/bin/env node
// Lean's iframe uses these fixed URLs, so a successful bundle alone is insufficient.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const infoviewFiles = [
  'index.css',
  'index.production.min.js',
  'loader.production.min.js',
  'react.production.min.js',
  'react-dom.production.min.js',
  'react-jsx-runtime.production.min.js',
  'codicon.ttf',
]
const copies = [
  ...infoviewFiles.map((file) => [
    `node_modules/@leanprover/infoview/dist/${file}`,
    `client/dist/infoview/${file}`,
  ]),
  [
    'node_modules/lean4monaco/dist/webview/webview.js',
    'client/dist/infoview/webview.js',
  ],
  [
    'node_modules/@leanprover/infoview/dist/codicon.ttf',
    'client/dist/assets/codicon.ttf',
  ],
]
for (const [source, destination] of copies) {
  const [expected, actual] = await Promise.all([
    readFile(new URL(source, root)),
    readFile(new URL(destination, root)),
  ])
  assert.ok(actual.length > 0, `Empty Lean asset: ${destination}`)
  assert.ok(actual.equals(expected), `Outdated Lean asset: ${destination}`)
}
console.log(
  `Verified ${copies.length} Lean editor assets at their public URLs.`,
)
