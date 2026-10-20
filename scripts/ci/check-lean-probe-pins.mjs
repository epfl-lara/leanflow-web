#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const versionPattern = /^v\d+\.\d+\.\d+(?:-rc\d+)?$/
const repositories = new Set([
  'https://github.com/augustepoiroux/repl.git',
  'https://github.com/leanprover-community/repl.git',
])

export function checkLeanProbePins(pins, presets, latest) {
  for (const [version, pin] of Object.entries(pins)) {
    assert(versionPattern.test(version), `Invalid REPL toolchain: ${version}`)
    assert(
      repositories.has(pin?.repository),
      `Invalid REPL repository: ${version}`,
    )
    assert(
      /^[0-9a-f]{40}$/.test(pin.revision),
      `Pin an exact REPL commit: ${version}`,
    )
    assert(
      versionPattern.test(pin.upstreamToolchain),
      `Record the upstream REPL toolchain: ${version}`,
    )
  }
  const required = new Set(
    presets.map(({ toolchain }) => {
      assert(
        typeof toolchain === 'string' &&
          toolchain.startsWith('leanprover/lean4:'),
        'Preset toolchains must name an official Lean release.',
      )
      return toolchain.slice('leanprover/lean4:'.length)
    }),
  )
  if (latest !== undefined) {
    assert(
      /^v\d+\.\d+\.\d+$/.test(latest),
      'Could not identify the latest stable Lean release.',
    )
    required.add(latest)
  }
  const missing = [...required].filter((version) => !pins[version])
  assert(
    missing.length === 0,
    `LeanProbe has no bundled REPL for ${missing.join(', ')}. Add and verify a compatible commit in deploy/lean-probe-repl-pins.json before building this worker.`,
  )
  return [...required]
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2)
    assert(
      args.length === 0 || (args.length === 1 && args[0] === '--latest'),
      'Usage: node scripts/ci/check-lean-probe-pins.mjs [--latest]',
    )
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const pins = JSON.parse(
      await fs.readFile(
        path.join(root, 'deploy/lean-probe-repl-pins.json'),
        'utf8',
      ),
    )
    const presets = JSON.parse(
      await fs.readFile(path.join(root, 'server/presets.json'), 'utf8'),
    )
    let latest
    if (args.includes('--latest')) {
      const response = await fetch(
        'https://api.github.com/repos/leanprover/lean4/releases/latest',
        {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'leanflow-worker-check',
          },
          signal: AbortSignal.timeout(15000),
        },
      )
      assert(
        response.ok,
        `Could not check the latest Lean release (HTTP ${response.status}). Retry the worker build when GitHub is available.`,
      )
      latest = (await response.json()).tag_name
    }
    console.log(
      `LeanProbe REPL pins cover ${checkLeanProbePins(pins, presets, latest).join(', ')}.`,
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
