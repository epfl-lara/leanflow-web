import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDependencyBuildPlan } from '../dependency-targets.mjs'
import { dependencyBuildCommand } from '../project-libraries.mjs'

test('dependency commands build evaluated library targets and extra dependencies without package demos or root fallback', () => {
  const plan = parseDependencyBuildPlan(
    'LEANFLOW_DEPENDENCY_TARGETS=' +
      JSON.stringify([
        ['verso', ['Verso', 'MultiVerso']],
        ['«empty-dependency»', []],
      ]),
  )
  assert.deepEqual(dependencyBuildCommand('@verso', plan), [
    'lake',
    'build',
    '@verso:extraDep',
    '@verso/Verso',
    '@verso/MultiVerso',
  ])
  assert.deepEqual(dependencyBuildCommand('@«empty-dependency»', plan), [
    'lake',
    'build',
    '@«empty-dependency»:extraDep',
  ])
  assert.throws(
    () => dependencyBuildCommand('@missing', plan),
    /did not report/,
  )
})

test('missing, malformed and unsafe Lake target reports cannot select arbitrary commands or paths', () => {
  for (const output of [
    '',
    'LEANFLOW_DEPENDENCY_TARGETS={}',
    ...[
      [['../private', []]],
      [['verso', ['Foo:exe']]],
      [['verso', ['../Other']]],
      [
        ['verso', []],
        ['verso', []],
      ],
    ].map((value) => 'LEANFLOW_DEPENDENCY_TARGETS=' + JSON.stringify(value)),
  ])
    assert.throws(() => parseDependencyBuildPlan(output))
})
