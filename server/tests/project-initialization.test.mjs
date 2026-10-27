import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  hasLeanConfiguration,
  initializeLeanEnvironment,
  leanConfigurationFiles,
} from '../project-initialization.mjs'
const selection = { toolchain: 'leanprover/lean4:v4.35.0', imports: ['Lean'] }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-init-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
test('initialization adds usable configuration and never replaces existing files or symlinks', async (t) => {
  const root = await fixture(t)
  const target = path.join(root, 'paper.txt')
  await fs.writeFile(target, 'preserve')
  await fs.symlink('paper.txt', path.join(root, 'Main.lean'))
  await fs.writeFile(path.join(root, '.gitignore'), 'original\n')
  const created = await initializeLeanEnvironment(root, selection)
  assert.deepEqual(created.sort(), ['lakefile.toml', 'lean-toolchain'])
  assert.equal(
    await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
    'preserve',
  )
  assert.equal(await fs.readlink(path.join(root, 'Main.lean')), 'paper.txt')
  assert.equal(
    await fs.readFile(path.join(root, '.gitignore'), 'utf8'),
    'original\n',
  )
  assert.match(
    await fs.readFile(path.join(root, 'lakefile.toml'), 'utf8'),
    /defaultTargets = \["Main"\]/,
  )
})
test('every existing configuration marker, including a dangling symlink, prevents initialization', async (t) => {
  for (const name of leanConfigurationFiles) {
    const root = await fixture(t)
    await fs.symlink('missing', path.join(root, name))
    assert.equal(await hasLeanConfiguration(root), true)
    await assert.rejects(initializeLeanEnvironment(root, selection), {
      status: 409,
    })
    assert.deepEqual(await fs.readdir(root), [name])
  }
})
test('initialization refuses a symlinked root and preserves files outside the project', async (t) => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'original'))
  await fs.symlink('original', path.join(root, 'redirect'))
  await assert.rejects(
    initializeLeanEnvironment(path.join(root, 'redirect'), selection),
  )
  assert.deepEqual(await fs.readdir(path.join(root, 'original')), [])
})
test('an incomplete library template fails without leaving partial Lean configuration', async (t) => {
  const root = await fixture(t),
    template = await fixture(t)
  await fs.writeFile(
    path.join(template, 'lean-toolchain'),
    selection.toolchain + '\n',
  )
  await assert.rejects(
    initializeLeanEnvironment(root, { ...selection, template }),
    { status: 503 },
  )
  assert.deepEqual(await fs.readdir(root), [])
})
