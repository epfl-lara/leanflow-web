import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const repository = await execute('git', ['rev-parse', '--show-toplevel'], {
  cwd: root,
}).then(
  (result) => path.resolve(result.stdout.trim()) === path.resolve(root),
  () => false,
)

test(
  'a worker archive contains exactly its declared source and no platform metadata',
  { skip: !repository },
  async (t) => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-package-'))
    t.after(() => fs.rm(output, { recursive: true, force: true }))
    const { stdout } = await execute(
      process.execPath,
      [
        path.join(root, 'scripts/package-cluster-worker.mjs'),
        '--output',
        output,
        '--allow-dirty',
      ],
      { cwd: root },
    )
    const release = JSON.parse(stdout)
    const listing = (await execute('tar', ['-tzf', release.archive])).stdout
      .trim()
      .split('\n')
      .filter((name) => !name.endsWith('/'))
      .map((name) => name.replace(/^\.\//, ''))
    const manifest = JSON.parse(
      (
        await execute('tar', [
          '-xOzf',
          release.archive,
          './worker-release.json',
        ])
      ).stdout,
    )
    assert.deepEqual(
      listing.sort(),
      [
        'worker-release.json',
        ...manifest.files.map((file) => file.path),
      ].sort(),
    )
    assert.ok(
      !listing.some((name) =>
        name.split('/').some((part) => part.startsWith('._')),
      ),
    )
    assert.equal(manifest.bundleDigest, release.bundleDigest)
  },
)
