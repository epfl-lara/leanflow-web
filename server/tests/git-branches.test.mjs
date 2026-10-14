import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateGitBranch } from '../git-branches.mjs'

const execute = promisify(execFile)

test('working and destination branches validate as Git branch names', async () => {
  for (const value of [
    'main',
    'leanflow/proof-results',
    'feature/mathlib-v4.35.0-rc4',
    'Proof_Results/step-2',
    'a'.repeat(121),
  ]) {
    assert.equal(validateGitBranch(value), value)
    const result = await execute('git', ['check-ref-format', '--branch', value])
    assert.equal(result.stdout.trim(), value)
  }
})

test('invalid or unsafe branch inputs fail at the request boundary', () => {
  for (const value of [
    undefined,
    null,
    42,
    [],
    {},
    '',
    'HEAD',
    '--delete',
    '-topic',
    '.hidden',
    'topic/.hidden',
    'topic.lock/step',
    'topic/step.lock',
    'topic/step.',
    'topic/',
    'topic//step',
    'topic..step',
    '../main',
    'two words',
    'topic\nstep',
    'topic\\step',
    'topic:step',
    'topic@{1}',
    'topic^step',
    'topic~step',
    'topic?step',
    'topic*step',
    'a'.repeat(122),
  ])
    assert.throws(
      () => validateGitBranch(value),
      (error) =>
        error.status === 400 && error.message === 'Choose a valid branch name.',
      `Unexpectedly accepted branch ${JSON.stringify(value)}`,
    )
})

test('the feature can return an actionable branch-specific error', () => {
  assert.throws(
    () =>
      validateGitBranch('../main', {
        message: 'Choose a valid destination branch name.',
      }),
    (error) =>
      error.status === 400 &&
      error.message === 'Choose a valid destination branch name.',
  )
})
