import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  instrumentOptimizationSource,
  measureOptimization,
  optimizationTheorems,
  proofTokenCount,
} from '../optimization.mjs'

async function fixture(t, source = 'theorem target : True := by trivial\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-optimization-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'Main.lean'), source)
  return root
}

const lakeEnv = {
  LEAN_SYSROOT: '/opt/lean-toolchains/leanprover--lean4---v4.34.1',
  LEAN_PATH:
    '/workspace/.lake/build/lib/lean:/opt/lean-toolchains/leanprover--lean4---v4.34.1/lib/lean',
  LEAN_SRC_PATH: '/workspace',
}

function workerResult(entries, raw = 12345) {
  return {
    compiled: true,
    available: true,
    reason: null,
    files: entries.map((entry) => ({
      path: entry.path,
      theorems: entry.theorems.map((theorem) => ({
        name: theorem.name,
        tokens: theorem.tokens,
        heartbeatsRaw: raw,
        heartbeats: raw / 1000,
      })),
    })),
  }
}

test('proof body tokens preserve the pinned operator grouping, literals, tabs, and nested comments', () => {
  assert.equal(proofTokenCount('by\n  exact Nat.add_comm a b'), 5)
  assert.equal(proofTokenCount('by simp <;> omega'), 4)
  assert.equal(proofTokenCount('x := y != z && a -> b <= c >= d'), 13)
  assert.equal(
    proofTokenCount('by /- outer /- nested -/ comment -/\n  rfl -- trailing'),
    2,
  )
  assert.equal(proofTokenCount('by\n\trfl'), 3)
  assert.equal(proofTokenCount('by\r  rfl'), 2)
  assert.equal(proofTokenCount('by exact "--"'), 6)
  assert.throws(() => proofTokenCount('by /- unfinished'), /Unterminated/)
})

test('theorem extraction handles namespace context and binder defaults without counting statements', () => {
  const source =
    'import Lean\nnamespace A\nsection\nvariable (n : Nat)\n@[simp] theorem α (x : Nat := 1) : x = x := by\n  rfl\n\nlemma second : True := True.intro\nend\nend A\n'
  const theorems = optimizationTheorems(source)
  assert.deepEqual(
    theorems.map((item) => [item.name, item.tokens]),
    [
      ['A.α', 2],
      ['A.second', 1],
    ],
  )
  assert.equal(
    source.slice(theorems[0].bodyStart, theorems[0].end).trim(),
    'by\n  rfl',
  )
  assert.equal(
    source.slice(theorems[1].bodyStart, theorems[1].end).trim(),
    'True.intro',
  )
})

test('instrumentation retains all source context and uses exact UTF-8 command ends', () => {
  const source =
    'import Lean\nnamespace Ω\n/-- First theorem. -/\n@[simp]\ntheorem α : True := by\n  trivial\nend Ω\n'
  const { content, theorems } = instrumentOptimizationSource(source, 'fixture')
  assert.equal(theorems[0].name, 'Ω.α')
  assert.match(content, /IO\.getNumHeartbeats/)
  assert.match(
    content,
    /set_option Elab\.async false in set_option maxHeartbeats 0/,
  )
  assert.match(content, /in\n\/-- First theorem\. -\/\n@\[simp\]\ntheorem α/)
  const marker =
    /#lemex_web_measure "fixture\/0" target "Ω.α" end (\d+) in\n/.exec(content)
  const tail = content.indexOf('  trivial') + '  trivial'.length
  assert.equal(Number(marker[1]), Buffer.byteLength(content.slice(0, tail)))
  assert.ok(content.endsWith('end Ω\n'))
})

test('nested have proofs retain their inner assignment boundaries in optimization measurement', () => {
  const body =
    'by\n  have inner : 1 = 1 := by\n    rfl\n  have combined : True ∧ 1 = 1 := by\n    exact ⟨True.intro, inner⟩\n  exact combined.2'
  const source = `theorem outer : 1 = 1 := ${body}\n\ntheorem next : True := by trivial\n`
  const spans = optimizationTheorems(source)
  assert.equal(source.slice(spans[0].bodyStart, spans[0].end).trim(), body)
  assert.equal(spans[0].tokens, proofTokenCount(body))
  const measured = instrumentOptimizationSource(source, 'nested')
  assert(measured.content.includes(`theorem outer : 1 = 1 := ${body}`))
  assert.equal(measured.theorems.length, 2)
})

test('unsupported declarations are explicit rather than returning guessed measurements', () => {
  for (const source of [
    'private theorem hidden : True := by trivial\n',
    'module\ntheorem target : True := by trivial\n',
    'theorem target : True\n',
    'theorem target : let p := True; p := by trivial\n',
    'namespace A; theorem target : True := by trivial\n',
    'theorem target : True := by\n  trivial\nwhere auxiliary := 1\n',
  ]) {
    assert.throws(() => optimizationTheorems(source), undefined, source)
  }
})

test('measurement resolves Lake first, runs fresh readonly with no network, and returns real numeric totals', async (t) => {
  const root = await fixture(
    t,
    'theorem first : True := by trivial\ntheorem second : True := True.intro\n',
  )
  const calls = [],
    runtime = {
      async run(actual, args, options) {
        calls.push({ root: actual, args, options })
        if (args[0] === 'lake')
          return { code: 0, stdout: JSON.stringify(lakeEnv), stderr: '' }
        return {
          code: 0,
          stdout: JSON.stringify(workerResult(JSON.parse(args.at(-1)))),
          stderr: '',
        }
      },
    }
  const result = await measureOptimization(runtime, root, ['Main.lean'])
  assert.equal(result.available, true)
  assert.equal(result.compiled, true)
  assert.equal(result.totalTokens, 3)
  assert.equal(result.totalHeartbeatsRaw, 24690)
  assert.equal(result.proofTokens, 3)
  assert.equal(result.heartbeats, 24.69)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args.slice(0, 3), ['lake', 'env', 'python3'])
  assert.deepEqual(calls[1].args.slice(0, 3), ['python3', '-I', '-c'])
  assert.deepEqual(calls[1].options.env, lakeEnv)
  for (const call of calls) {
    assert.equal(call.options.network, 'none')
    for (const flag of ['readOnlyWorkspace', 'freshHome', 'readOnlyHome'])
      assert.equal(call.options[flag], true)
    assert.ok(!call.options.env?.LEMEX_API_KEY)
  }
  assert.equal(
    await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
    'theorem first : True := by trivial\ntheorem second : True := True.intro\n',
  )
})

test('valid unsupported metrics remain distinct from actual compiler failure', async (t) => {
  const root = await fixture(t)
  for (const compiled of [true, false, null]) {
    const runtime = {
      async run(_root, args) {
        return {
          code: 0,
          stdout: JSON.stringify(
            args[0] === 'lake'
              ? lakeEnv
              : {
                  available: false,
                  compiled,
                  files: [],
                  reason: 'explicit reason',
                },
          ),
          stderr: '',
        }
      },
    }
    const result = await measureOptimization(runtime, root, ['Main.lean'])
    assert.equal(result.compiled, compiled)
    assert.equal(result.available, false)
    assert.equal(result.totalTokens, null)
    assert.equal(result.totalHeartbeatsRaw, null)
    assert.equal(result.reason, 'explicit reason')
  }
})

test('missing, duplicate, invalid, or forged metric rows fail closed without fabricated totals', async (t) => {
  const root = await fixture(t)
  for (const tamper of [
    (result) => (result.files[0].theorems = []),
    (result) => result.files[0].theorems.push(result.files[0].theorems[0]),
    (result) => (result.files[0].theorems[0].heartbeatsRaw = -1),
    (result) => (result.files[0].theorems[0].tokens = 999),
    (result) => (result.files[0].theorems[0].heartbeats = 12345),
  ]) {
    const runtime = {
      async run(_root, args) {
        if (args[0] === 'lake')
          return { code: 0, stdout: JSON.stringify(lakeEnv), stderr: '' }
        const result = workerResult(JSON.parse(args.at(-1)))
        tamper(result)
        return { code: 0, stdout: JSON.stringify(result), stderr: '' }
      },
    }
    const result = await measureOptimization(runtime, root, ['Main.lean'])
    assert.equal(result.available, false)
    assert.equal(result.totalHeartbeatsRaw, null)
  }
})

test('unsafe paths, symlinks, unsupported source, and untrusted environments never launch measurement', async (t) => {
  const root = await fixture(t)
  await fs.symlink(path.join(root, 'Main.lean'), path.join(root, 'Link.lean'))
  let calls = 0
  const runtime = {
    async run() {
      calls++
      return {
        code: 0,
        stdout: JSON.stringify({ ...lakeEnv, LEAN_PATH: '/etc' }),
        stderr: '',
      }
    },
  }
  for (const filename of [
    '../Main.lean',
    '/Main.lean',
    '.lake/packages/P.lean',
    'Link.lean',
    'lakefile.lean',
  ])
    assert.equal(
      (await measureOptimization(runtime, root, [filename])).available,
      false,
    )
  assert.equal(calls, 0)
  const result = await measureOptimization(runtime, root, ['Main.lean'])
  assert.equal(result.available, false)
  assert.match(result.reason, /environment/)
  assert.equal(calls, 1)
})

test('timeout or abort cannot masquerade as a successful measurement', async (t) => {
  const root = await fixture(t)
  const runtime = {
    async run(_root, args) {
      if (args[0] === 'lake')
        return { code: 0, stdout: JSON.stringify(lakeEnv), stderr: '' }
      return {
        code: 0,
        timedOut: true,
        stdout: JSON.stringify(workerResult(JSON.parse(args.at(-1)))),
        stderr: '',
      }
    },
  }
  assert.equal(
    (await measureOptimization(runtime, root, ['Main.lean'])).available,
    false,
  )
})
