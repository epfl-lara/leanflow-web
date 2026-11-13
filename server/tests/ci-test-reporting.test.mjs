import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))

async function runReporter(t, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-ci-report-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(
    path.join(directory, 'npm'),
    `#!${process.execPath}\n${source}`,
    { mode: 0o700 },
  )
  const env = {
    ...process.env,
    PATH: directory + path.delimiter + process.env.PATH,
  }
  // The CLI starts from a workflow shell, outside this test runner's context.
  delete env.NODE_TEST_CONTEXT
  try {
    return {
      code: 0,
      ...(await execute(process.execPath, ['scripts/ci/check-tests.mjs'], {
        cwd: root,
        env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      })),
    }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return error
  }
}

test('CI preserves the failing exit code and annotates escaped diagnostic output', async (t) => {
  const result = await runReporter(
    t,
    `process.stdout.write('failure with 100% output\\r\\nsecond line\\n'); process.exitCode = 7`,
  )
  assert.equal(result.code, 7)
  assert.match(result.stdout, /failure with 100% output/)
  assert.match(
    result.stderr,
    /::error title=Application tests failed::failure with 100%25 output%0D%0Asecond line%0A/,
  )
  assert.doesNotMatch(result.stdout, /portable options/)
})

test('CI streams complete logs while bounding the failure annotation to the diagnostic tail', async (t) => {
  const result = await runReporter(
    t,
    `process.stdout.write('x'.repeat(65536) + '\\nFAILURE_TAIL\\n'); process.exitCode = 1`,
  )
  assert.equal(result.code, 1)
  assert(result.stdout.length > 65536)
  assert(result.stderr.length < 34000)
  assert.match(result.stderr, /FAILURE_TAIL%0A/)
})

test('CI runs the portable fixture tests after application tests succeed', async (t) => {
  const result = await runReporter(
    t,
    `console.log('APPLICATION_FIXTURE_PASSED')`,
  )
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /APPLICATION_FIXTURE_PASSED/)
  assert.match(result.stdout, /public fixture records every tracked source/)
  assert.doesNotMatch(result.stderr, /::error/)
})
