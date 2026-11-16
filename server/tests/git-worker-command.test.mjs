import assert from 'node:assert/strict'
import test from 'node:test'
import { gitWorkerCommand, NETWORK_GIT } from '../git-worker-command.mjs'
import { gitCredentialsRunner, gitHttpsArgs } from '../git-credentials.mjs'

test('fixed Git worker commands retain operands and disable hooks, fsmonitor and configured editors', () => {
  const command = gitWorkerCommand([
    'git',
    '-c',
    'core.hooksPath=/workspace/hooks',
    'status',
    '--porcelain=v2',
  ])
  assert.deepEqual(command.slice(-2), ['status', '--porcelain=v2'])
  assert(
    command.indexOf('core.hooksPath=/dev/null') >
      command.indexOf('core.hooksPath=/workspace/hooks'),
  )
  assert(command.includes('credential.helper='))
  assert(command.includes('core.fsmonitor=false'))
  assert(command.includes('core.editor=/bin/false'))
})

test('only the exact existing network and credential wrappers can accompany Git', () => {
  for (const script of [NETWORK_GIT, gitCredentialsRunner]) {
    const command = gitWorkerCommand([
      'python3',
      '-c',
      script,
      ...gitHttpsArgs,
      'fetch',
      '--',
      'https://github.com/fixture/project.git',
    ])
    assert.deepEqual(command.slice(0, 4), ['python3', '-c', script, 'git'])
    assert.equal(
      command.filter((value) => value === 'credential.helper=').length,
      1,
    )
  }
})

test('Git worker capability refuses shells, arbitrary Python, aliases, editors and repository escapes', () => {
  for (const args of [
    ['sh', '-c', 'git status'],
    ['python3', '-c', 'print("not a fixed runner")', 'git', 'status'],
    ['git', 'shell'],
    ['git', '-c', 'alias.proof=!lean Main.lean', 'proof'],
    ['git', '--exec-path=/workspace/bin', 'status'],
    ['git', '--git-dir=/workspace/../other/.git', 'status'],
    ['git', '-c', 'credential.helper=!sh /workspace/helper', 'fetch'],
    ['git', 'config', '--edit'],
    ['git', 'difftool'],
    ['git', 'help', '-w', 'status'],
  ])
    assert.throws(() => gitWorkerCommand(args))
})

test('Git object checks and configuration capability discovery retain their fixed noninteractive forms', () => {
  assert.equal(
    gitWorkerCommand(['git', 'fsck', '--full', '--strict']).at(-3),
    'fsck',
  )
  assert.deepEqual(gitWorkerCommand(['git', 'help', '--config']).slice(-2), [
    'help',
    '--config',
  ])
})
