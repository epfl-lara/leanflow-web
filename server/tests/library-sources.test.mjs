import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createStudio } from '../studio.mjs'
import { Runtime } from '../runtime.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const signature = 'theorem pos_of_neZero (n : Nat) [NeZero n] : 0 < n'
const content = `namespace Nat\n\n${signature} := by trivial\nend Nat\n`

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-library-source-'),
  )
  const installedRoot = path.join(dataDir, 'toolchain', 'src', 'lean')
  await fs.mkdir(path.join(installedRoot, 'Init', 'Data', 'Nat'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(installedRoot, 'Init', 'Data', 'Nat', 'Basic.lean'),
    content,
  )
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain }],
    templateRoot: () => null,
    toolchainSourceRoot: (value) => {
      assert.equal(value, toolchain)
      return installedRoot
    },
    async prepareToolchain() {},
    async shutdown() {},
    spawn() {
      assert.fail('Source reads must not launch workers')
    },
    async run(root, args) {
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true })
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    config: {
      defaultModel: 'fixture',
      models: [{ id: 'fixture' }],
      provider: {},
      lemex: {},
      redact: String,
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await studio.workspaces.create('owner', {
    name: 'Source fixture',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  runtime.run = () =>
    assert.fail(
      'Viewing sources must not start commands or prepare a toolchain',
    )
  const token = (
    await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')
  ).trim()
  const otherToken = 'other-source-fixture'
  studio.auth.users.push({
    id: 'other',
    name: 'Other',
    tokenHash: createHash('sha256').update(otherToken).digest('hex'),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth', 'users.json'),
    JSON.stringify(studio.auth.users),
  )
  const url = `http://127.0.0.1:${studio.server.address().port}`
  const request = (body, access = token) =>
    fetch(`${url}/api/projects/${project.id}/library-source`, {
      method: 'POST',
      headers: {
        Origin: url,
        'Content-Type': 'application/json',
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
  return {
    studio,
    store: studio.workspaces,
    project,
    installedRoot,
    dataDir,
    runtime,
    request,
    otherToken,
  }
}

test('source endpoint reads the pinned core module locally, authenticates and never writes it', async (t) => {
  const f = await fixture(t)
  const response = await f.request({ module: 'Init.Data.Nat.Basic', signature })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    module: 'Init.Data.Nat.Basic',
    path: 'Lean library/Init/Data/Nat/Basic.lean',
    toolchain,
    content,
    readOnly: true,
    line: 3,
    endLine: 3,
  })
  assert.equal(
    (await f.request({ module: 'Init.Data.Nat.Basic' }, '')).status,
    401,
  )
  assert.equal(
    (await f.request({ module: 'Init.Data.Nat.Basic' }, f.otherToken)).status,
    404,
  )
  assert.equal(
    await fs.readFile(
      path.join(f.installedRoot, 'Init/Data/Nat/Basic.lean'),
      'utf8',
    ),
    content,
  )
  const moduleOnly = await f.request({
    module: 'Init.Data.Nat.Basic',
    signature: 'theorem changed : False',
  })
  assert.equal((await moduleOnly.json()).line, null)
  const missing = await f.request({ module: 'Init.Data.Nat.Missing' })
  assert.equal(missing.status, 404)
})

test('source endpoint rejects traversal, invalid values and symlink escapes without exposing host files', async (t) => {
  const f = await fixture(t)
  for (const module of [
    '../../etc/passwd',
    '/etc/passwd',
    'Init..Basic',
    'Init/Data/Nat/Basic',
    'Init\\Basic',
    null,
    ['Init'],
    'Init.' + 'a'.repeat(1000),
  ])
    assert.equal((await f.request({ module })).status, 400)
  for (const badSignature of [42, {}, null, 'a'.repeat(16001)])
    assert.equal(
      (
        await f.request({
          module: 'Init.Data.Nat.Basic',
          signature: badSignature,
        })
      ).status,
      400,
    )
  await fs.writeFile(path.join(f.dataDir, 'secret.lean'), 'private fixture')
  await fs.symlink(
    path.join(f.dataDir, 'secret.lean'),
    path.join(f.installedRoot, 'Init', 'Secret.lean'),
  )
  await fs.symlink(f.dataDir, path.join(f.installedRoot, 'Init', 'Escape'))
  for (const module of ['Init.Secret', 'Init.Escape.secret']) {
    const response = await f.request({ module })
    assert.equal(response.status, 403)
    assert.equal(
      JSON.stringify(await response.json()).includes('private fixture'),
      false,
    )
  }
})

test('dependency modules open from the shared library root without deriving paths from namespaces', async (t) => {
  const f = await fixture(t)
  const shared = path.join(f.dataDir, 'shared')
  const filename = '.lake/packages/mathlib/Mathlib/Data/Nat/Basic.lean'
  await fs.mkdir(path.dirname(path.join(shared, filename)), { recursive: true })
  const libraryContent =
    'namespace Deep.Nested.Namespace\ntheorem declaration : True := by trivial\nend Deep.Nested.Namespace\n'
  await fs.writeFile(path.join(shared, filename), libraryContent)
  f.runtime.dependencyRoot = async () => shared
  const response = await f.request({
    module: 'Mathlib.Data.Nat.Basic',
    signature: 'theorem declaration : True',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    module: 'Mathlib.Data.Nat.Basic',
    path: filename,
    toolchain,
    content: libraryContent,
    readOnly: true,
    line: 2,
    endLine: 2,
  })
  assert.equal(
    (await f.request({ module: 'Deep.Nested.Namespace.declaration' })).status,
    404,
  )
  await fs.mkdir(path.join(shared, '.lake/packages/other/Mathlib/Data/Nat'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(shared, '.lake/packages/other/Mathlib/Data/Nat/Basic.lean'),
    libraryContent,
  )
  assert.equal(
    (await f.request({ module: 'Mathlib.Data.Nat.Basic' })).status,
    404,
  )
})

test('source viewer avoids ambiguous local signatures and reports unavailable toolchains', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(
    path.join(f.installedRoot, 'Init/Data/Nat/Basic.lean'),
    content + content,
  )
  assert.equal(
    (
      await (
        await f.request({ module: 'Init.Data.Nat.Basic', signature })
      ).json()
    ).line,
    null,
  )
  f.runtime.toolchainSourceRoot = () => null
  const response = await f.request({ module: 'Init.Data.Nat.Basic' })
  assert.equal(response.status, 404)
  assert.match((await response.json()).error, /Prepare the project/)
  f.runtime.toolchainSourceRoot = () =>
    path.join(f.dataDir, 'missing-source-root')
  const missingSources = await f.request({ module: 'Init.Data.Nat.Basic' })
  assert.equal(missingSources.status, 404)
  assert.match((await missingSources.json()).error, /Use Open source/)
})

test('runtime resolves source roots only from installed pinned toolchains', () => {
  const runtime = new Runtime({ dataDir: '/tmp/source-root-fixture' })
  runtime.toolchains.set(toolchain, '/tmp/source-root-fixture/toolchain')
  assert.equal(
    runtime.toolchainSourceRoot(toolchain),
    '/tmp/source-root-fixture/toolchain/src/lean',
  )
  assert.equal(runtime.toolchainSourceRoot('leanprover/lean4:v4.32.0'), null)
})

test('Lean definition URIs open the actual pinned source position and reject other toolchains or paths', async (t) => {
  const f = await fixture(t)
  for (const prefix of [
    '/opt/lean-toolchains/leanprover--lean4---v4.34.1/src/lean/',
    '/home/worker/.elan/toolchains/leanprover--lean4---v4.34.1/src/lean/',
  ]) {
    const response = await f.request({
      uri: `file://${prefix}Init/Data/Nat/Basic.lean`,
      line: 3,
      endLine: 3,
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).line, 3)
  }
  const uri =
    'file:///opt/lean-toolchains/leanprover--lean4---v4.34.1/src/lean/Init/Data/Nat/Basic.lean'
  for (const badUri of [
    uri.replace('v4.34.1', 'v4.32.0'),
    'file:///etc/passwd',
    uri.replace('file:///', 'file://host/'),
    uri.replace('file:', 'https:'),
    uri + '?query=1',
    uri + '#L3',
    uri.replace('Init/Data/Nat/Basic.lean', 'Init/%2e%2e/%2e%2e/secret.lean'),
    uri.replace('Basic.lean', '%2Fetc%2Fpasswd.lean'),
  ])
    assert.equal((await f.request({ uri: badUri, line: 3 })).status, 400)
  for (const line of [0, -1, 999, '3', 3.5, null])
    assert.equal((await f.request({ uri, line })).status, 400)
  assert.equal((await f.request({ uri, line: 3, endLine: 2 })).status, 400)
  assert.equal(
    (await f.request({ uri, module: 'Init.Data.Nat.Basic', line: 3 })).status,
    400,
  )
})
