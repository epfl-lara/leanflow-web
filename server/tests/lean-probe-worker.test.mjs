import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('LeanProbe scratch cleanup preserves warm state and serializes concurrent requests', async () => {
  const result = await promisify(execFile)(
    'python3',
    ['scripts/test_lean_probe_worker.py'],
    { cwd: new URL('../../', import.meta.url), timeout: 30000 },
  )
  assert.match(result.stderr, /Ran 5 tests/)
  assert.match(result.stderr, /OK/)
})
