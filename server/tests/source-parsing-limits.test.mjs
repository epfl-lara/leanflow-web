import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { proofSkeleton } from '../verification.mjs'
import { optimizationTheorems } from '../optimization.mjs'

test('repeated attributes cannot stall proof guards, measurement, or search', () => {
  // Keep the deadline in a separate process: a synchronous regexp can block
  // both the HTTP event loop and a test runner's ordinary timeout callback.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict'
    import { proofSkeleton, proofRisks } from './server/verification.mjs'
    import { optimizationTheorems } from './server/optimization.mjs'
    import { searchDeclarations } from './server/search.mjs'
    for (const source of ['@[simp] '.repeat(4000), 'private\\n'.repeat(50000)].map(prefix => prefix + 'not_a_declaration')) {
    assert(proofSkeleton(source).includes('not_a_declaration'))
    assert(Array.isArray(proofRisks([{path:'Main.lean', before:source, after:source}], 'proofs')))
    assert.deepEqual(optimizationTheorems(source), [])
    const response = await searchDeclarations(
      {query:'fixture', backend:'leanexplore', projectId:'fixture'}, 'fixture',
      {get:()=>({toolchain:'leanprover/lean4:v4.34.1'})},
      {fetchImpl:async()=>Response.json({results:[{name:'fixture',source_text:source}]})},
    )
    assert.equal(response.results[0].signature, '')
    }
  `,
    ],
    {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
      timeout: 5000,
    },
  )
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
})

test('ordinary consecutive attributes preserve proof boundaries and measurement', () => {
  const before = '@[simp] @[local simp] theorem named : True := by\n  trivial\n'
  const after = before.replace('trivial', 'exact True.intro')
  assert.equal(proofSkeleton(before), proofSkeleton(after))
  assert.deepEqual(
    optimizationTheorems(before).map(({ name }) => name),
    ['named'],
  )
  // Unsupported nested attribute syntax must fail closed, keeping the body
  // in the comparison, instead of guessing which bracket ends the prefix.
  const nested = '@[custom [value]] theorem named : True := by trivial\n'
  assert.notEqual(
    proofSkeleton(nested),
    proofSkeleton(nested.replace('trivial', 'sorry')),
  )
  assert.throws(() => optimizationTheorems(nested), /conventional/)
})
