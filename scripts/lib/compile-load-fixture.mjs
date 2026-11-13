import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function compileLoadWorkloads(account, { native, toolchain, mathlib }) {
  assert.equal(toolchain.trim(), 'leanprover/lean4:v4.35.0')
  for (const [source, prefix, count] of [
    [native, 'assoc_', 400],
    [mathlib, 'arithmetic_', 120],
  ]) {
    const names = [...source.matchAll(/^theorem (\w+)\b/gm)].map((m) => m[1])
    assert.deepEqual(
      names,
      Array.from({ length: count }, (_, i) => prefix + i),
    )
    const namespace = 'User' + account.name.slice(-2)
    assert(source.split('\n').includes('namespace ' + namespace))
    assert(source.split('\n').includes('end ' + namespace))
  }
  assert(mathlib.split('\n').includes('import Mathlib'))
  assert.equal([...native.matchAll(/:= Nat\.add_assoc a b c$/gm)].length, 400)
  assert.equal([...mathlib.matchAll(/:= by norm_num$/gm)].length, 120)
  return {
    userId: account.id,
    nativeToolchain: toolchain.trim(),
    nativeTheorems: 400,
    mathlibTheorems: 120,
    sourceDigests: {
      native: createHash('sha256').update(native).digest('hex'),
      mathlib: createHash('sha256').update(mathlib).digest('hex'),
    },
  }
}

export function loadTestSetting(name) {
  const value = process.env[name]?.trim()
  assert(value, `Set ${name}; live load tests have no production defaults.`)
  return value
}

// These scripts create check jobs and the browser test edits fixture sources.
// Require explicit opt-in, ten non-admin fixture identities and private tokens.
export async function compileLoadFixture() {
  assert.equal(
    process.env.STUDIO_RUN_LIVE_LOAD_TEST,
    '1',
    'Set STUDIO_RUN_LIVE_LOAD_TEST=1 only for disposable test accounts.',
  )
  const filename = path.resolve(loadTestSetting('STUDIO_LOAD_FIXTURE'))
  const stat = await fs.lstat(filename)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
  assert.equal(stat.uid, process.getuid())
  assert.equal(
    stat.mode & 0o077,
    0,
    'Keep the fixture token file private (mode 0600).',
  )
  assert(stat.size <= 1024 * 1024)
  const state = JSON.parse(await fs.readFile(filename, 'utf8'))
  assert(/^LF load \d{8} [a-f0-9]{8}$/.test(state.runTag))
  assert.equal(state.accounts.length, 10)
  assert.equal(new Set(state.accounts.map((account) => account.id)).size, 10)
  for (const [index, account] of state.accounts.entries()) {
    assert(/^[a-f0-9]{24}$/.test(account.id))
    assert.equal(
      account.name,
      state.runTag + ' U' + String(index + 1).padStart(2, '0'),
    )
    assert(/^[A-Za-z0-9_-]{40,100}$/.test(account.token))
    for (const kind of ['native', 'mathlib']) {
      const project = account.projects[kind]
      assert(/^[a-f0-9-]{36}$/.test(project.id))
      assert(project.name.startsWith(account.name + ' '))
    }
  }
  const origin = new URL(loadTestSetting('STUDIO_LOAD_ORIGIN'))
  assert(['http:', 'https:'].includes(origin.protocol))
  assert(
    origin.protocol === 'https:' ||
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname),
    'Use HTTPS for non-loopback live tests.',
  )
  assert(!origin.username && !origin.password && !origin.search && !origin.hash)
  assert.equal(origin.pathname, '/')
  const directory = path.resolve(loadTestSetting('STUDIO_LOAD_OUTPUT'))
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const output = await fs.lstat(directory)
  assert(output.isDirectory() && !output.isSymbolicLink())
  assert.equal(output.uid, process.getuid())
  assert.equal(
    output.mode & 0o077,
    0,
    'Keep live test reports in a private directory.',
  )
  const rounds = process.env.STUDIO_LOAD_ROUNDS || 'all'
  assert(['all', 'native', 'mathlib', 'mixed'].includes(rounds))
  return { state, directory, origin: origin.origin, rounds }
}
