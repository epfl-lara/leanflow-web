import test from 'node:test'
import assert from 'node:assert/strict'
import { maskLean, proofRisks, verifyCandidate } from '../verification.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { proofLayouts } from './fixtures/proof-layouts.mjs'

const modes = ['repair', 'prove', 'optimize']
const risks = (before, after, mode = 'repair') =>
  proofRisks([{ path: 'Main.lean', before, after }], mode)

test('valid proof layouts and unchanged statement formatting do not cause false rejections', () => {
  for (const { name, before, after } of proofLayouts)
    for (const mode of ['proofs', 'prove', 'repair', 'optimize'])
      assert.deepEqual(risks(before, after, mode), [], `${mode}: ${name}`)
})

test('layout support still catches changes after a proof and changes to literal and identifier boundaries', () => {
  for (const { name, before, after } of proofLayouts) {
    const surrounding = 'def fixed : Nat := 42\n'
    assert(
      risks(before + surrounding, after + surrounding.replace('42', '0'))
        .length,
      name,
    )
    assert(
      risks(
        before + surrounding,
        after + surrounding.replace('fixed', 'changed'),
      ).length,
      name,
    )
  }
  for (const [before, after] of [
    ['def word : String := "a  b"\n', 'def word : String := "a b"\n'],
    ['def word : String := "keep"\n', 'def word : String := "changed"\n'],
    [
      'def a : Nat := 1\ndef f a : Nat := a\n',
      'def a : Nat := 1\ndef fa : Nat := a\n',
    ],
    ['def f? : Nat := 0\n', 'def f ? : Nat := 0\n'],
  ])
    assert(risks(before, after).length, after)
})

const helperBefore = `namespace Proofs
def targetValue : Nat := 42
theorem target : targetValue = 42 := by
  sorry
end Proofs
`
const helperAfter = `namespace Proofs
def targetValue : Nat := 42
private theorem helper : targetValue = 42 := by
  rfl
theorem target : targetValue = 42 := by
  exact helper
@[simp] theorem another (n : Nat) : n = n := by
  rfl
end Proofs
`

test('unsupported embedded proof terms report an inconclusive boundary check rather than a definite code change', () => {
  const before = 'def bounded : {n : Nat // n = 0} := ⟨0, by sorry⟩\n'
  const problems = risks(before, before.replace('sorry', 'rfl'))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /could not confirm/)
  assert.match(problems[0], /unsupported proof syntax/)
  assert.doesNotMatch(problems[0], /changes code outside/)
})

test('Proofs can add checked theorems and helper lemmas around existing proofs', () => {
  for (const mode of ['proofs', 'prove', 'repair']) {
    assert.deepEqual(risks(helperBefore, helperAfter, mode), [], mode)
    assert.deepEqual(
      risks(
        'def value : Nat := 42\n',
        'def value : Nat := 42\ntheorem spec : value = 42 := by rfl\n',
        mode,
      ),
      [],
      mode,
    )
    assert.deepEqual(
      risks(
        helperBefore,
        helperAfter.replace('private theorem helper', 'private lemma helper'),
        mode,
      ),
      [],
      mode,
    )
  }
  assert(risks(helperBefore, helperAfter, 'optimize').length)
})

test('adding lemmas cannot hide changed statements, assumptions, definitions, imports, or commands', () => {
  const before = 'import Lean\n' + helperBefore
  for (const after of [
    helperAfter,
    'import Lean\n' +
      helperAfter.replace('target : targetValue = 42', 'target : True'),
    'import Lean\n' +
      helperAfter.replace('targetValue : Nat := 42', 'targetValue : Nat := 0'),
    'import Lean\n' +
      helperAfter.replace('namespace Proofs', 'namespace Other'),
    'import Lean\n' +
      helperAfter.replace(
        'namespace Proofs',
        'namespace Proofs\nvariable (h : False)',
      ),
    'import Lean\n' +
      helperAfter.replace(
        '  rfl\ntheorem target',
        '  rfl\n  attribute [simp] helper\ntheorem target',
      ),
    'import Lean\n' +
      helperAfter.replace(
        '  rfl\ntheorem target',
        '  rfl set_option maxHeartbeats 0\ntheorem target',
      ),
    'import Lean\n' +
      helperAfter.replace('  rfl\ntheorem target', '  sorry\ntheorem target'),
    'import Lean\n' +
      helperAfter.replace('private theorem helper', 'axiom helper'),
  ]) {
    for (const mode of ['proofs', 'prove', 'repair', 'optimize'])
      assert(risks(before, after, mode).length, `${mode}: ${after}`)
  }
})

test('new helpers with matching short names preserve each namespace’s original theorem', () => {
  const before =
    'namespace A\ntheorem helper : True := by trivial\nend A\nnamespace B\ntheorem target : True := by sorry\nend B\n'
  const after = before
    .replace(
      'theorem target',
      'private theorem helper : True := by trivial\ntheorem target',
    )
    .replace('by sorry', 'by exact helper')
  assert.deepEqual(risks(before, after), [])
  assert(
    risks(
      before,
      after.replace('theorem helper : True', 'theorem helper : False'),
    ).some((problem) => problem.includes('statement')),
  )
})

test('new helper declarations reach the independent build and kernel audit', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-helper-check-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const calls = []
  const runtime = {
    async run(_root, args) {
      calls.push(args)
      if (args[1] === 'env')
        return {
          code: 0,
          stdout: JSON.stringify({
            LEAN_SYSROOT: '/opt/lean-toolchains/pinned',
            LEAN_PATH: '/workspace/.lake/build/lib/lean',
            LEAN_SRC_PATH: '/workspace',
          }),
          stderr: '',
        }
      if (args.includes('build')) return { code: 0, stdout: '', stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({
          complete: true,
          compiled: true,
          kernelChecked: true,
          files: [],
          axioms: [],
          errors: [],
          warnings: ['Unused variable.'],
        }),
        stderr: '',
      }
    },
  }
  const result = await verifyCandidate(
    runtime,
    root,
    [{ path: 'Main.lean', before: helperBefore, after: helperAfter }],
    'proofs',
  )
  assert.equal(
    result.complete,
    true,
    'Ordinary compiler warnings do not block acceptance',
  )
  assert.deepEqual(calls[1], ['lake', 'build'])
  assert.deepEqual(JSON.parse(calls[2].at(-1)), [
    {
      path: 'Main.lean',
      names: [
        'Proofs.targetValue',
        'Proofs.helper',
        'Proofs.target',
        'Proofs.another',
      ],
    },
  ])
})

test('numeric shifts and evaluation commands reach Lean verification in every mode', () => {
  const before = `import Mathlib
def shifted (n bits : Nat) : Nat := n <<< bits
#eval shifted 3 4
#reduce shifted 3 4
#eval show IO Unit from do
  IO.println (shifted 3 4)
theorem target : shifted 3 4 = 48 := by
  sorry
`
  const after = before.replace('sorry', 'rfl')
  for (const mode of ['proofs', ...modes, 'formalize', 'search']) {
    assert.deepEqual(risks(before, after, mode), [], mode)
  }
  for (const mode of ['formalize', 'search']) {
    assert.deepEqual(risks(null, after, mode), [], mode)
  }
})

test('ordinary Lean metaprogramming is checked by Lean instead of a keyword ban', () => {
  const after = `import Lean
syntax "answer" : term
macro_rules | \`(answer) => \`(42)
elab "fortyTwo" : term => return Lean.mkNatLit 42
initialize greeting : Nat ← pure 42
run_cmd Lean.logInfo "ready"
theorem target : (answer : Nat) = fortyTwo := by
  run_tac Lean.logInfo "checking"
  rfl
`
  for (const mode of ['formalize', 'search']) {
    assert.deepEqual(risks(null, after, mode), [], mode)
  }
  const before = 'import Lean\ntheorem target : True := by\n  sorry\n'
  for (const mode of modes) {
    for (const command of [
      'run_tac Lean.logInfo "checking"',
      'run_tac IO.println "checking"',
    ]) {
      assert.deepEqual(
        risks(before, before.replace('sorry', `${command}\n  trivial`), mode),
        [],
        mode,
      )
    }
  }
})

test('ambiguous top-level theorem statements cannot be weakened through an embedded assignment', () => {
  for (const mode of modes) {
    for (const keyword of ['let', 'have']) {
      const before = `theorem target : ${keyword} n := 5; n * 2 = 10 := by decide\n`
      const after = `theorem target : ${keyword} n := 1; True := by trivial\n`
      assert(
        risks(before, after, mode).some((problem) =>
          problem.includes('unsupported theorem statement'),
        ),
      )
      assert(
        risks(before, before, mode).some((problem) =>
          problem.includes('unsupported theorem statement'),
        ),
      )
    }
  }
})

test('commands following a proof on the same line require manual review', () => {
  const before = 'theorem target : True := by trivial\n'
  for (const mode of modes) {
    for (const command of [
      'attribute [simp] target',
      'local notation "c" => 1',
      'open Nat',
      '#check Nat',
    ]) {
      const after = before.trimEnd() + ' ' + command + '\n'
      assert(
        risks(before, after, mode).some((problem) =>
          problem.includes('command inside a proof span'),
        ),
        command,
      )
    }
  }
})

test('character literal quotes do not hide trust changes or excluded tactics', () => {
  const before = 'import Lean\ntheorem target : True := by trivial\n'
  for (const command of [
    'set_option debug.skipKernelTC true in',
    'native_decide',
  ]) {
    const after = `import Lean\ntheorem target : True := by\n  let c := '"'\n  ${command}\n  trivial\n`
    assert.equal(maskLean(after).length, after.length)
    assert(maskLean(after).includes(command.split(' ')[0]))
    assert(risks(before, after, 'optimize').length, command)
  }
})

test('ordinary proof bodies, binder defaults, character literals, and qualified names remain supported', () => {
  const before = `def marker : Char := ' '\ntheorem target (n : Nat := 5) : n = n := by\n  sorry\n`
  const after = before.replace(
    'sorry',
    `let c := '"'\n  let x := "attribute run_tac"\n  let xs := #[n]\n  have h := Nat.add_comm n 0\n  rfl`,
  )
  for (const mode of modes) assert.deepEqual(risks(before, after, mode), [])
  assert(
    risks(
      before,
      after.replace("marker : Char := ' '", "marker : Char := '\\t'"),
    ).some((problem) => problem.includes('outside')),
  )
  assert(maskLean("theorem foo'x' : True := by trivial").includes("foo'x'"))
})
