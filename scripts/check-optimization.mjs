import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import { measureOptimization } from '../server/optimization.mjs'

// Compiler-only smoke check. It never requests a model or opens worker networking.
const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || '.data')
const runtime = new Runtime({ dataDir, scope: 'helper' })
const directory = path.join(
  dataDir,
  'runtime',
  'optimization-check',
  randomUUID(),
)
const results = {}
try {
  const info = await runtime.init()
  if (!info.ready) throw new Error(info.error)
  for (const preset of ['lean', 'mathlib']) {
    const template = runtime.templateRoot(preset)
    if (!template) {
      results[preset] = { skipped: 'The pinned preset has not been installed.' }
      continue
    }
    const root = path.join(directory, preset)
    await fs.mkdir(path.join(root, '.lake'), { recursive: true })
    for (const file of [
      'lean-toolchain',
      'lakefile.toml',
      'lake-manifest.json',
    ]) {
      try {
        await fs.copyFile(path.join(template, file), path.join(root, file))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    await fs.cp(path.join(template, '.lake'), path.join(root, '.lake'), {
      recursive: true,
      filter: (source) =>
        !source.startsWith(path.join(template, '.lake', 'packages')),
    })
    await runtime.inheritDependencies(template, root)
    await fs.writeFile(
      path.join(root, 'Helper.lean'),
      'theorem helper (n : Nat) : n = n := by rfl\n',
    )
    const imports =
      (preset === 'mathlib'
        ? 'import Mathlib.Data.Nat.Basic\n'
        : 'import Lean\n') + 'import Helper\n'
    const before =
      imports +
      'namespace Sample\n/-- An isolated metric fixture. -/\n@[simp]\ntheorem α (n : Nat := 1) : n + 0 = n := by\n  simp only [Nat.add_zero]\n\ntheorem ok : True := by\n  exact True.intro\nend Sample\n'
    const after = before.replace('  simp only [Nat.add_zero]', '  rfl')
    await fs.writeFile(path.join(root, 'Main.lean'), before)
    const baseline = await measureOptimization(runtime, root, [
      'Main.lean',
      'Helper.lean',
    ])
    assert.equal(baseline.available, true, baseline.reason)
    assert.equal(baseline.compiled, true)
    await fs.writeFile(path.join(root, 'Main.lean'), after)
    const candidate = await measureOptimization(runtime, root, [
      'Main.lean',
      'Helper.lean',
    ])
    assert.equal(candidate.available, true, candidate.reason)
    assert.equal(candidate.compiled, true)
    assert.equal(baseline.totalTokens, 11)
    assert.equal(candidate.totalTokens, 7)
    assert.ok(
      baseline.totalHeartbeatsRaw > 0 && candidate.totalHeartbeatsRaw > 0,
    )
    assert.equal(await fs.readFile(path.join(root, 'Main.lean'), 'utf8'), after)
    await fs.writeFile(
      path.join(root, 'Main.lean'),
      imports + 'theorem invalid : False := by trivial\n',
    )
    const invalid = await measureOptimization(runtime, root, ['Main.lean'])
    assert.equal(invalid.compiled, false)
    assert.equal(invalid.available, false)
    results[preset] = { baseline, candidate, invalid, sourceUnchanged: true }
  }
  console.log(JSON.stringify(results, null, 2))
} finally {
  await runtime.shutdown()
  await fs.rm(directory, { recursive: true, force: true })
}
