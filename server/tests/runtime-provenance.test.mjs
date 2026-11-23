import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { verifyPackagedRuntime } from '../../scripts/ci/runtime-provenance.mjs'

const provenance = {
  npm_package: '@example/runtime',
  version: '1.2.3',
  npm_version: '1.2.3',
  npm_integrity: 'sha512-fixture',
  native_target: 'x86_64-unknown-linux-musl',
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-provenance-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'packaged'))
  return {
    primary: path.join(root, 'packaged/manifest.json'),
    release: path.join(root, 'release-manifest.json'),
    check: (actual = provenance) =>
      verifyPackagedRuntime(actual, root, 'packaged'),
  }
}

test('source and release installations compare the actual worker to their packaged provenance', async (t) => {
  for (const source of [true, false])
    await t.test(source ? 'source' : 'release', async (t) => {
      const f = await fixture(t)
      await fs.writeFile(
        source ? f.primary : f.release,
        JSON.stringify(source ? provenance : { lemex: provenance }),
      )
      await f.check()
      for (const field of Object.keys(provenance))
        await assert.rejects(
          f.check({ ...provenance, [field]: 'different' }),
          (error) =>
            error.code === 'ERR_ASSERTION' &&
            error.actual === 'different' &&
            error.expected === provenance[field],
        )
    })
})

test('an existing source manifest takes precedence and errors never fall back silently', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.release, JSON.stringify({ lemex: provenance }))
  await fs.writeFile(f.primary, '{malformed')
  await assert.rejects(f.check(), SyntaxError)
  await fs.writeFile(
    f.primary,
    JSON.stringify({ ...provenance, npm_integrity: 'different' }),
  )
  await assert.rejects(
    f.check(),
    (error) =>
      error.code === 'ERR_ASSERTION' &&
      error.actual === provenance.npm_integrity &&
      error.expected === 'different',
  )
  await fs.rm(f.primary)
  await fs.mkdir(f.primary)
  await assert.rejects(f.check(), { code: 'EISDIR' })
})

test('missing, malformed, or incomplete release provenance fails verification', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.check(), { code: 'ENOENT' })
  await fs.writeFile(f.release, '{malformed')
  await assert.rejects(f.check(), SyntaxError)
  await fs.writeFile(f.release, '{}')
  await assert.rejects(f.check(), /no Lemex runtime provenance/)
  await fs.writeFile(
    f.release,
    JSON.stringify({ lemex: { ...provenance, native_target: null } }),
  )
  await assert.rejects(f.check(), /no Lemex runtime field: native_target/)
})

test('a staged release refuses to switch with a missing or substituted discovery runtime', async (t) => {
  const f = await fixture(t)
  const root = path.dirname(f.release)
  const packaged = path.join(root, '.runtime/lemex')
  const executable = '#!/bin/sh\necho "lemex 1.2.3"\n'
  const expected = {
    ...provenance,
    native_artifact_sha256: {
      lemex: createHash('sha256').update(executable).digest('hex'),
    },
  }
  const populate = async (home) => {
    await fs.mkdir(path.join(home, 'bin'), { recursive: true })
    await fs.writeFile(
      path.join(home, 'lemex-install.json'),
      JSON.stringify(expected),
    )
    await fs.writeFile(path.join(home, 'config.toml'), 'model = "fixture"\n')
    await fs.writeFile(
      path.join(home, 'models.json'),
      '{"models":[{"slug":"fixture"}]}',
    )
    await fs.writeFile(path.join(home, 'bin/lemex'), executable, {
      mode: 0o700,
    })
  }
  const other = path.join(root, 'previous-release')
  await populate(other)
  await fs.writeFile(f.release, JSON.stringify({ lemex: expected }))
  const check = () =>
    promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            '../../scripts/ci/check-discovery-runtime.mjs',
            import.meta.url,
          ),
        ),
        root,
      ],
      { env: { PATH: process.env.PATH, LEMEX_HOME: other } },
    )
  await assert.rejects(
    check,
    (error) =>
      error.code === 1 &&
      error.stderr.includes(path.join(packaged, 'lemex-install.json')),
  )
  await populate(packaged)
  await fs.appendFile(
    path.join(packaged, 'bin/lemex'),
    '# Replaced executable with the same version\n',
  )
  await assert.rejects(
    check,
    (error) =>
      error.code === 1 &&
      error.stderr.includes(
        'Lemex executable differs from the release manifest',
      ),
  )
})
