import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { checkLeanProbePins } from '../../scripts/ci/check-lean-probe-pins.mjs'

const pins = JSON.parse(
  await fs.readFile(
    new URL('../../deploy/lean-probe-repl-pins.json', import.meta.url),
    'utf8',
  ),
)
const presets = JSON.parse(
  await fs.readFile(new URL('../presets.json', import.meta.url), 'utf8'),
)

test('the worker bundles pinned REPL sources for every prepared library and default Lean version', () => {
  const required = checkLeanProbePins(pins, presets)
  assert.deepEqual(
    new Set(required),
    new Set(
      presets.map(({ toolchain }) =>
        toolchain.replace('leanprover/lean4:', ''),
      ),
    ),
  )
  assert(required.includes('v4.35.0'))
  assert(required.includes('v4.35.0-rc4'))
  assert(required.includes('v4.34.1'))
})

test('the optional latest release gate rejects a stable version without its REPL pin', () => {
  assert.doesNotThrow(() => checkLeanProbePins(pins, presets, 'v4.35.0'))
  assert.throws(
    () => checkLeanProbePins(pins, presets, 'v999.0.0'),
    /no bundled REPL for v999\.0\.0.*before building/,
  )
  const incomplete = { ...pins }
  delete incomplete['v4.35.0-rc4']
  assert.throws(
    () => checkLeanProbePins(incomplete, presets),
    /no bundled REPL for v4\.35\.0-rc4/,
  )
  assert.throws(
    () => checkLeanProbePins(pins, presets, 'v4.36.0-rc1'),
    /latest stable Lean release/,
  )
})

test('REPL pins require trusted source repositories, exact commits, and recorded upstream toolchains', () => {
  for (const change of [
    { repository: 'https://example.invalid/repl.git' },
    { revision: 'main' },
    { upstreamToolchain: 'nightly' },
  ])
    assert.throws(() =>
      checkLeanProbePins(
        { ...pins, 'v4.35.0': { ...pins['v4.35.0'], ...change } },
        presets,
      ),
    )
})

test('the ordinary pin check works offline while the optional latest gate requires discovery', async () => {
  const script = fileURLToPath(
    new URL('../../scripts/ci/check-lean-probe-pins.mjs', import.meta.url),
  )
  const source = `
    globalThis.fetch = () => { throw new Error('Discovery is offline'); };
    process.argv = [process.execPath, ${JSON.stringify(script)}, ...process.argv.slice(1)];
    await import(${JSON.stringify(new URL('../../scripts/ci/check-lean-probe-pins.mjs', import.meta.url).href)});
  `
  const run = promisify(execFile)
  const result = await run(process.execPath, [
    '--input-type=module',
    '-e',
    source,
  ])
  assert.match(result.stdout, /LeanProbe REPL pins cover/)
  await assert.rejects(
    run(process.execPath, [
      '--input-type=module',
      '-e',
      source,
      '--',
      '--latest',
    ]),
    (error) => error.code === 1 && /Discovery is offline/.test(error.stderr),
  )
})
