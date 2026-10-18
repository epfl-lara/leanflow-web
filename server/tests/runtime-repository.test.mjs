import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'terminal-checkout-'),
  )
  const dataDir = path.join(directory, 'data')
  const checkout = path.join(dataDir, 'projects', 'selected')
  const root = path.join(checkout, 'Lean')
  const docker = path.join(directory, 'docker-fixture')
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true })
  await fs.mkdir(root)
  await fs.mkdir(path.join(dataDir, 'runtime'))
  await fs.writeFile(
    docker,
    `#!${process.execPath}\nif(process.argv[2] === 'run') console.log(JSON.stringify(process.argv.slice(2)))\n`,
    { mode: 0o700 },
  )
  const runtime = new Runtime({ dataDir, docker })
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  t.after(async () => {
    await runtime.shutdown()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { runtime, directory, dataDir, checkout, root }
}

const mounts = (argv) =>
  argv.flatMap((value, index) => (value === '--mount' ? [argv[index + 1]] : []))

test('nested terminals expose their checkout and mirror readonly dependencies into the selected folder', async (t) => {
  const f = await fixture(t)
  const source = path.join(f.dataDir, 'dependencies')
  await fs.mkdir(path.join(source, '.lake/packages/Fixture'), {
    recursive: true,
  })
  await f.runtime.inheritDependencies(source, f.root)
  const argv = JSON.parse(
    (await f.runtime.run(f.root, ['true'], { repositoryRoot: f.checkout }))
      .stdout,
  )
  const mounted = mounts(argv)
  assert(mounted.includes(`type=bind,src=${f.checkout},dst=/repository`))
  assert(mounted.includes(`type=bind,src=${f.root},dst=/workspace`))
  assert(
    mounted.includes(
      `type=bind,src=${source}/.lake/packages,dst=/workspace/.lake/packages,readonly`,
    ),
  )
  assert(
    mounted.includes(
      `type=bind,src=${source}/.lake/packages,dst=/repository/Lean/.lake/packages,readonly`,
    ),
  )
  assert.equal(argv[argv.indexOf('--workdir') + 1], '/repository/Lean')
  assert(argv.includes('LEAN_PROJECT_PATH=/repository/Lean'))
  assert(!mounted.some((mount) => mount.includes(`src=${f.dataDir},`)))
})

test('repository mounts preserve readonly workspace and explicit writable build-cache settings', async (t) => {
  const f = await fixture(t)
  const argv = JSON.parse(
    (
      await f.runtime.run(f.root, ['true'], {
        repositoryRoot: f.checkout,
        readOnlyWorkspace: true,
        writeLakeCache: true,
      })
    ).stdout,
  )
  const mounted = mounts(argv)
  assert(
    mounted.includes(`type=bind,src=${f.checkout},dst=/repository,readonly`),
  )
  assert(mounted.includes(`type=bind,src=${f.root},dst=/workspace,readonly`))
  assert(mounted.includes(`type=bind,src=${f.root}/.lake,dst=/workspace/.lake`))
  assert(
    mounted.includes(
      `type=bind,src=${f.root}/.lake,dst=/repository/Lean/.lake`,
    ),
  )
})

test('terminal checkout mounts reject unrelated, broader, symlinked and missing Git roots', async (t) => {
  const f = await fixture(t)
  const sibling = path.join(f.dataDir, 'projects', 'sibling')
  const outside = path.join(f.directory, 'outside')
  await fs.mkdir(path.join(sibling, '.git'), { recursive: true })
  await fs.mkdir(path.join(outside, '.git'), { recursive: true })
  await fs.mkdir(path.join(f.dataDir, 'projects', '.git'))
  await fs.symlink(f.checkout, path.join(f.dataDir, 'alias'))
  for (const repositoryRoot of [
    f.dataDir,
    path.dirname(f.checkout),
    sibling,
    outside,
    f.root,
    path.join(f.dataDir, 'alias'),
    12,
  ])
    await assert.rejects(f.runtime.run(f.root, ['true'], { repositoryRoot }))
  await fs.rm(path.join(f.checkout, '.git'), { recursive: true })
  await fs.symlink(path.join(sibling, '.git'), path.join(f.checkout, '.git'))
  await assert.rejects(
    f.runtime.run(f.root, ['true'], { repositoryRoot: f.checkout }),
    /selected Git repository/,
  )
  assert.equal(f.runtime.children.size, 0)
})

test('nested repository aliases pin every selected ancestor and each writable cache path', async (t) => {
  const f = await fixture(t)
  const root = path.join(f.checkout, 'Nested/Lean')
  await fs.mkdir(root, { recursive: true })
  const argv = JSON.parse(
    (await f.runtime.run(root, ['true'], { repositoryRoot: f.checkout }))
      .stdout,
  )
  const mounted = mounts(argv)
  for (const relative of ['Nested', 'Nested/Lean'])
    assert(
      mounted.includes(
        `type=bind,src=${f.checkout}/${relative},dst=/repository/${relative}`,
      ),
    )
  for (const alias of ['/workspace', '/repository/Nested/Lean']) {
    assert(mounted.includes(`type=bind,src=${root}/.lake,dst=${alias}/.lake`))
    assert(
      mounted.includes(
        `type=bind,src=${root}/.lake/packages,dst=${alias}/.lake/packages`,
      ),
    )
  }
})
