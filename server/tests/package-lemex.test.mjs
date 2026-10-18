import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('npm runtime packaging excludes host secrets and rejects invalid or redirected native assets', async () => {
  const result = await promisify(execFile)(
    'python3',
    ['scripts/test_package_lemex.py'],
    { cwd: new URL('../../', import.meta.url), timeout: 30000 },
  )
  assert.match(result.stderr, /Ran 3 tests/)
  assert.match(result.stderr, /OK/)
})
