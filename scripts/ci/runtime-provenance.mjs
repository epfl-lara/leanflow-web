import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function verifyPackagedRuntime(
  actual,
  projectDir,
  runtimeDir = process.env.LEMEX_RUNTIME_DIR || '.runtime/lemex',
) {
  let expected
  try {
    expected = JSON.parse(
      await fs.readFile(
        path.resolve(projectDir, runtimeDir, 'manifest.json'),
        'utf8',
      ),
    )
  } catch (error) {
    // Release archives omit private build state and retain the same npm
    // provenance in their public manifest. Malformed/unreadable source
    // manifests must fail verification rather than silently selecting another.
    if (error.code !== 'ENOENT') throw error
    expected = JSON.parse(
      await fs.readFile(path.join(projectDir, 'release-manifest.json'), 'utf8'),
    ).lemex
  }
  assert(
    expected && typeof expected === 'object' && !Array.isArray(expected),
    'The package manifest has no Lemex runtime provenance.',
  )
  for (const field of [
    'npm_package',
    'version',
    'npm_version',
    'npm_integrity',
    'native_target',
  ]) {
    assert(
      typeof expected[field] === 'string' && expected[field].length > 0,
      `The package manifest has no Lemex runtime field: ${field}`,
    )
    assert.equal(
      actual[field],
      expected[field],
      `Worker differs from the packaged runtime: ${field}`,
    )
  }
}
