import test from 'node:test'
import assert from 'node:assert/strict'
import { maskLean, proofRisks } from '../verification.mjs'

const modes = ['repair', 'prove', 'optimize']
const risks = (before, after, mode = 'repair') =>
  proofRisks([{ path: 'Main.lean', before, after }], mode)

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
