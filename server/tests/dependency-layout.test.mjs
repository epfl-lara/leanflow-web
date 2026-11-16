import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  localDependencyDirectories,
  validateDependencyLayout,
} from '../dependency-layout.mjs'

test('local dependencies retain safe normalized project folders and never widen the selected root', () => {
  const packages = [
    'vendor/local',
    './vendor/local/',
    'vendor/unused/../local',
    '/workspace/vendor/local',
    '.',
    '',
  ].map((dir) => ({ name: 'local', type: 'path', dir }))
  assert.deepEqual(localDependencyDirectories({ packages }), [
    'vendor/local',
    '.',
  ])
  for (const dir of [
    '../common',
    '../../private',
    '/etc',
    '/workspace-sibling/pkg',
    '/workspace/../common',
  ])
    assert.throws(
      () =>
        localDependencyDirectories({
          packages: [{ name: 'common', type: 'path', dir }],
        }),
      {
        status: 409,
        unsupportedLayout: true,
        message:
          /outside the selected project folder.*project root contains both packages/,
      },
    )
  assert.deepEqual(
    localDependencyDirectories({
      packages: [{ name: 'library', type: 'git', dir: '../ignored' }],
    }),
    [],
  )
})

test('malformed local paths remain configuration errors eligible for ordinary correction', () => {
  for (const dir of [undefined, null, false, {}, 'bad\0path'])
    assert.throws(
      () =>
        localDependencyDirectories({
          packages: [{ name: 'local', type: 'path', dir }],
        }),
      (error) => error.status === 400 && !error.unsupportedLayout,
    )
})

test('manifest paths outside the selected folder fail before configuration evaluation', async () => {
  await assert.rejects(
    validateDependencyLayout({
      'lake-manifest.json': JSON.stringify({
        packages: [{ name: 'common', type: 'path', dir: '../common' }],
      }),
    }),
    { status: 409, unsupportedLayout: true },
  )
  await validateDependencyLayout({
    'lake-manifest.json': JSON.stringify({
      packages: [{ name: 'local', type: 'path', dir: 'vendor/local' }],
    }),
  })
})

test('literal TOML local dependencies are checked without needing a manifest or evaluating project code', async () => {
  for (const content of [
    'name = "fixture"\n[[require]]\nname = "common"\npath = "../common"\n',
    'name = "fixture"\nrequire = [{name="common", path="../../common"}]\n',
    "name = 'fixture'\n[[require]]\nname = 'common'\npath = '../../private workspace'\n",
  ])
    await assert.rejects(
      validateDependencyLayout({ 'lakefile.toml': content }),
      { status: 409, unsupportedLayout: true },
    )
  await validateDependencyLayout({
    'lakefile.toml':
      'name = "fixture"\n[[require]]\nname = "local"\npath = "vendor/local"\n',
  })
})

test('inactive TOML and malformed configurations do not replace Lake diagnostics or execute Lean code', async () => {
  await validateDependencyLayout({
    'lakefile.toml': '[[require]]\nname="ignored"\npath="../ignored"\n',
    'lakefile.lean': '',
  })
  await validateDependencyLayout({
    'lakefile.toml': 'name = [ malformed',
    'lake-manifest.json': 'malformed',
  })
  await validateDependencyLayout({
    'lakefile.lean':
      'import Lake\n#eval panic! "configuration must never execute on host"\n',
  })
})

test('dependency layout inspection never executes Lean configuration or shell-like TOML path text on the host', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-layout-no-eval-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const sentinel = path.join(root, 'unexpected-execution')
  await validateDependencyLayout({
    'lakefile.lean': `import Lake\n#eval IO.FS.writeFile ${JSON.stringify(sentinel)} "executed"\n`,
  })
  await validateDependencyLayout({
    'lakefile.toml': `name = 'fixture'\n[[require]]\nname = 'local'\npath = '$(touch ${sentinel})'\n`,
  })
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' })
})
