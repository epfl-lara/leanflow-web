#!/usr/bin/env node
// Real compiler regression checks; no provider request and no user projects.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import { verifyCandidate } from '../server/verification.mjs'
import { proofLayouts } from '../server/tests/fixtures/proof-layouts.mjs'

const directory = new URL('../.runtime/verification-check/', import.meta.url)
  .pathname
const root = path.join(directory, randomUUID())
await fs.mkdir(root, { recursive: true })
const main =
  'import Lean\nimport Helper\n\ndef shifted (n bits : Nat) : Nat := n <<< bits\n#eval shifted 3 4\n#reduce shifted 3 4\nprivate def localShift : Nat := shifted 3 4\n\ntheorem target : True := by\n  exact imported_fact\n'
const helper = 'theorem imported_fact : True := by trivial\n'
await Promise.all([
  fs.writeFile(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.34.1\n'),
  fs.writeFile(
    path.join(root, 'lakefile.toml'),
    'name = "verification"\nversion = "0.1.0"\ndefaultTargets = ["Main"]\n\n[[lean_lib]]\nname = "Main"\n\n[[lean_lib]]\nname = "Helper"\n',
  ),
  fs.writeFile(path.join(root, 'Main.lean'), main),
  fs.writeFile(path.join(root, 'Helper.lean'), helper),
])
const runtime = new Runtime({
  dataDir: directory,
  hostToolchainDir: process.env.STUDIO_TEST_TOOLCHAIN_DIR,
})
const changes = [{ path: 'Main.lean', before: main, after: main }]
try {
  await runtime.init()
  assert.equal(runtime.info().ready, true, runtime.info().error)
  await runtime.prepareToolchain('leanprover/lean4:v4.34.1')
  const valid = await verifyCandidate(
    runtime,
    root,
    changes,
    'repair',
    () => {},
  )
  assert.equal(valid.complete, true, JSON.stringify(valid))
  assert.equal(valid.kernelChecked, true)
  for (const name of ['imported_fact', 'shifted', 'localShift', 'target']) {
    assert(
      valid.axioms.some((text) => text.includes(`${name} depends on axioms:`)),
    )
  }
  assert.deepEqual(
    valid.files.map((f) => f.module),
    ['Helper', 'Main'],
  )

  // A build-controlled local olean is never trusted by the independent audit.
  const poisoned = {
    run: async (source, args, options) => {
      const result = await runtime.run(source, args, options)
      if (args[1] === 'build' && result.code === 0) {
        const injection = await runtime.run(
          source,
          [
            'python3',
            '-I',
            '-c',
            String.raw`
import pathlib,subprocess
file=pathlib.Path('Helper.lean'); original=file.read_text()
try:
 file.write_text('axiom imported_fact : True\n')
 subprocess.run(['lake','env','lean','-o','.lake/build/lib/lean/Helper.olean','Helper.lean'],check=True)
finally:
 file.write_text(original)
`,
          ],
          { network: 'none' },
        )
        assert.equal(injection.code, 0, injection.stderr)
      }
      return result
    },
  }
  const replayed = await verifyCandidate(
    poisoned,
    root,
    changes,
    'repair',
    () => {},
  )
  assert.equal(replayed.complete, true, JSON.stringify(replayed))
  assert(
    replayed.axioms.some((text) =>
      text.includes('imported_fact depends on axioms: []'),
    ),
  )
  assert(replayed.axioms.every((text) => !text.includes('[imported_fact]')))

  await fs.writeFile(
    path.join(root, 'Helper.lean'),
    'axiom imported_fact : True\n',
  )
  const axiom = await verifyCandidate(
    runtime,
    root,
    changes,
    'repair',
    () => {},
  )
  assert.equal(axiom.compiled, true, JSON.stringify(axiom))
  assert.equal(axiom.complete, false)
  assert(axiom.errors.some((text) => text.includes('Nonstandard axioms')))
  await fs.writeFile(path.join(root, 'Helper.lean'), helper)
  const layouts = []
  for (const { name, before, after } of proofLayouts) {
    await fs.writeFile(path.join(root, 'Main.lean'), before)
    const baseline = await runtime.run(
      root,
      ['lake', 'env', 'lean', 'Main.lean'],
      { network: 'none' },
    )
    assert.equal(
      baseline.code,
      0,
      `${name}: ${baseline.stdout}\n${baseline.stderr}`,
    )
    await fs.writeFile(path.join(root, 'Main.lean'), after)
    const result = await verifyCandidate(
      runtime,
      root,
      [{ path: 'Main.lean', before, after }],
      'proofs',
      () => {},
    )
    assert.equal(result.complete, true, `${name}: ${JSON.stringify(result)}`)
    assert.equal(result.kernelChecked, true, name)
    layouts.push(name)
  }
  console.log(
    `PASS: readonly independent audit, local import source replay, poisoned olean exclusion, transitive axiom rejection, ${layouts.length} real Lean proof-layout regressions`,
  )
  await fs.writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify({ root, valid, replayed, axiom, layouts }, null, 2),
  )
} finally {
  await runtime.shutdown()
}
