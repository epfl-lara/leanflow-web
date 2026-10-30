import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDependencyBuildPlan } from '../dependency-targets.mjs'
import {
  dependencyBuildCommand,
  projectBuildCommand,
} from '../project-libraries.mjs'

test('dependency commands build evaluated library targets and extra dependencies without package demos or root fallback', () => {
  const plan = parseDependencyBuildPlan(
    'LEANFLOW_DEPENDENCY_TARGETS=' +
      JSON.stringify([
        ['verso', ['Verso', 'MultiVerso']],
        ['optional', ['Root', '+Root.Semantics.Optional']],
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
  assert.deepEqual(dependencyBuildCommand('@optional', plan), [
    'lake',
    'build',
    '@optional:extraDep',
    '@optional/Root',
    '@optional/+Root.Semantics.Optional',
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

test('project imports extend its normal default targets without selecting dependency demos', () => {
  assert.deepEqual(
    projectBuildCommand(
      { name: 'Project' },
      {
        '@Project': ['@Project/Project', '@Project/+Project.Optional'],
        '@library': ['@library/+Library.Optional'],
      },
    ),
    ['lake', 'build', '@Project', '@Project/+Project.Optional'],
  )
  assert.deepEqual(projectBuildCommand({ name: 'Project' }, null), [
    'lake',
    'build',
  ])
  assert.deepEqual(
    projectBuildCommand({ name: 'Project' }, { '@Project': [] }),
    ['lake', 'build'],
  )
})
