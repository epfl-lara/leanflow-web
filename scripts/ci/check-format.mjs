#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const event = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  : {}
let base =
  event.pull_request?.base?.sha || event.merge_group?.base_sha || event.before
if (!base || /^0+$/.test(base)) {
  base = execFileSync('git', ['rev-parse', 'HEAD^'], {
    encoding: 'utf8',
  }).trim()
}
if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('Invalid formatting base')
const files = execFileSync(
  'git',
  ['diff', '--name-only', '--diff-filter=ACMRT', '-z', base, 'HEAD', '--'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter((file) =>
    /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|mdx?|css|scss|html)$/.test(file),
  )
if (files.length) {
  execFileSync('node_modules/.bin/oxfmt', ['--check', '--', ...files], {
    stdio: 'inherit',
  })
} else {
  console.log('No changed files supported by Oxfmt.')
}
