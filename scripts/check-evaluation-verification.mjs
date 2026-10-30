#!/usr/bin/env node
// Real compiler and proof checks in disposable projects; no provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import { verifyCandidate } from '../server/verification.mjs'

const reportDir = path.resolve('.runtime/evaluation-verification', randomUUID())
const runtime = new Runtime({
  dataDir: path.resolve(process.env.STUDIO_DATA_DIR || '.data'),
  scope: 'helper',
  maxConcurrent: 1,
  cpus: 1,
  memory: '4g',
})
const report = { providerCalls: 0, projects: [], passed: false }
const roots = []
const options = { freshHome: true, cleanHome: true }
await fs.mkdir(reportDir, { recursive: true })
try {
  const info = await runtime.init()
  assert.equal(info.ready, true, info.error)
  for (const preset of ['lean', 'mathlib']) {
    const template = runtime.templateRoot(preset)
    assert(template, `Prepare the pinned ${preset} preset before this check.`)
    const root = await fs.mkdtemp(
      path.join(runtime.runtimeDir, 'evaluation-verification-'),
    )
    roots.push(root)
    await fs.mkdir(path.join(root, '.lake'), { recursive: true })
    for (const file of [
      'lean-toolchain',
      'lakefile.toml',
      'lake-manifest.json',
    ]) {
      await fs.copyFile(path.join(template, file), path.join(root, file))
    }
    await runtime.inheritDependencies(template, root)
    const source = `${preset === 'mathlib' ? 'import Mathlib\n' : 'import Lean\n'}
def shifted (n bits : Nat) : Nat := n <<< bits
#eval shifted 3 4
#reduce shifted 3 4
#eval show IO Unit from do
  IO.println (shifted 3 4)
theorem target : shifted 3 4 = 48 := by
  run_tac Lean.logInfo "checking numeric shift"
  rfl
`
    const file = path.join(root, 'Main.lean')
    await fs.writeFile(file, source)
    const change = {
      path: 'Main.lean',
      before: source.replace('  rfl', '  sorry'),
      after: source,
    }
    const valid = await verifyCandidate(
      runtime,
      root,
      [change],
      'repair',
      undefined,
      options,
    )
    assert.equal(valid.complete, true, JSON.stringify(valid))
    assert.equal(valid.compiled, true)
    assert.equal(valid.kernelChecked, true)
    assert(valid.files.some((entry) => entry.module === 'Main'))
    for (const name of ['shifted', 'target']) {
      assert(
        valid.axioms.some((text) =>
          text.includes(`${name} depends on axioms:`),
        ),
      )
    }
    assert.equal(await fs.readFile(file, 'utf8'), source)

    const invalidSource = source.replace('= 48', '= 49')
    await fs.writeFile(file, invalidSource)
    const invalid = await verifyCandidate(
      runtime,
      root,
      [{ path: 'Main.lean', before: null, after: invalidSource }],
      'formalize',
      undefined,
      options,
    )
    assert.equal(invalid.complete, false)
    assert.equal(invalid.compiled, false)
    assert.match(invalid.reason, /does not build/)
    report.projects.push({
      preset,
      toolchain: (
        await fs.readFile(path.join(root, 'lean-toolchain'), 'utf8')
      ).trim(),
      valid,
      invalid,
      sourceUnchanged: true,
    })
    console.log(
      `PASS: ${preset} numeric shifts, evaluation, IO and proof checks`,
    )
  }
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
} finally {
  await runtime.shutdown()
  for (const root of roots) {
    await runtime.clearInheritedDependencies(root, { force: true })
    await fs.rm(root, { recursive: true, force: true })
  }
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(
  JSON.stringify({ passed: report.passed, reportDir, error: report.error }),
)
