import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dependencyBuildTargets,
  dependencyPackageDirectory,
} from '../project-libraries.mjs'

test('dependency builds address packages explicitly and preserve escaped Lake names', () => {
  const manifest = {
    packages: [
      { type: 'git', name: 'mathlib' },
      { type: 'git', name: 'verso' },
      { type: 'git', name: '«verso-slides»', inherited: true },
      { type: 'path', name: 'local' },
    ],
  }
  assert.deepEqual(dependencyBuildTargets(manifest), ['@verso'])
  assert.deepEqual(
    dependencyBuildTargets(manifest, {
      includeInherited: true,
      includeMathlib: true,
    }),
    ['@mathlib', '@verso', '@«verso-slides»'],
  )
  assert.equal(dependencyPackageDirectory('«verso-slides»'), 'verso-slides')
  assert.equal(dependencyPackageDirectory('Mathlib'), 'Mathlib')
  assert.equal(dependencyPackageDirectory('«αλγεβρα»'), 'αλγεβρα')
})

test('dependency directories cannot introduce paths, options, facets or malformed escapes', () => {
  for (const name of [
    null,
    '../private',
    '«../private»',
    'foo/bar',
    'foo:bar',
    '@foo',
    '--help',
    'foo\0bar',
    '«foo',
    'foo»',
    '««foo»»',
    'a'.repeat(129),
  ])
    assert.equal(dependencyPackageDirectory(name), null, String(name))
})
