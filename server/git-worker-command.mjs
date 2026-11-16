import { gitCredentialsRunner } from './git-credentials.mjs'

export const NETWORK_GIT = `import os, sys
env = dict(os.environ)
env.pop('GIT_SSL_NO_VERIFY', None)
os.execvpe(sys.argv[1], sys.argv[1:], env)
`

const operations = new Set([
  'status',
  'diff',
  'log',
  'rev-parse',
  'rev-list',
  'symbolic-ref',
  'for-each-ref',
  'ls-files',
  'ls-tree',
  'cat-file',
  'show',
  'merge-base',
  'config',
  'init',
  'switch',
  'add',
  'commit',
  'read-tree',
  'write-tree',
  'update-ref',
  'fetch',
  'clone',
  'push',
  'pull',
  'merge',
  'bundle',
  'branch',
  'checkout',
  'reset',
  'remote',
  'fsck',
  'help',
])
const configuration =
  /^(?:user\.(?:name|email)|core\.(?:hooksPath|fsmonitor|autocrlf|editor|pager)|credential\.(?:helper|useHttpPath)|http\.(?:followRedirects|proxy|sslVerify|curloptResolve|extraHeader)|protocol\.(?:(?:https|file)\.)?allow|fetch\.fsckObjects|push\.followTags|commit\.gpgSign|log\.showSignature)$/i

// This capability is only for server-built Git commands. In particular, a shell,
// arbitrary Python runner, Git alias/plugin or configured editor cannot use it
// to bypass Lean's prepared-dependency validation.
export function gitWorkerCommand(args) {
  if (
    !Array.isArray(args) ||
    args.some((value) => typeof value !== 'string' || value.includes('\0'))
  )
    throw new Error('Git workers require fixed Git command arguments.')
  let prefix = []
  if (
    args[0] === 'python3' &&
    args[1] === '-c' &&
    [NETWORK_GIT, gitCredentialsRunner].includes(args[2])
  ) {
    prefix = args.slice(0, 3)
    args = args.slice(3)
  }
  if (args[0] !== 'git')
    throw new Error(
      'Git workers accept only Git and the fixed credential runners.',
    )
  let index = 1,
    credentialReset = false
  while (index < args.length && args[index].startsWith('-')) {
    const flag = args[index]
    if (flag === '-c') {
      const value = args[index + 1]
      const equals = value?.indexOf('=') ?? -1
      const name = equals > 0 ? value.slice(0, equals) : ''
      if (!configuration.test(name))
        throw new Error('Unsupported Git worker configuration.')
      if (name.toLowerCase() === 'credential.helper') {
        if (value.slice(equals + 1) !== '')
          throw new Error('Git worker credentials must use the fixed broker.')
        credentialReset = true
      }
      index += 2
    } else if (
      [
        '--literal-pathspecs',
        '--no-pager',
        '--no-optional-locks',
        '--no-replace-objects',
      ].includes(flag) ||
      /^--git-dir=\/workspace(?:\/[A-Za-z0-9_.-]+)+$/.test(flag)
    ) {
      if (
        flag.startsWith('--git-dir=') &&
        flag
          .slice('--git-dir='.length)
          .split('/')
          .some((part) => part === '.' || part === '..')
      )
        throw new Error(
          'Git worker repository paths must stay inside the workspace.',
        )
      index++
    } else throw new Error('Unsupported Git worker global option.')
  }
  const operation = args[index]
  if (!operations.has(operation))
    throw new Error('Unsupported Git worker operation.')
  if (
    operation === 'help' &&
    (args.length !== index + 2 || args[index + 1] !== '--config')
  )
    throw new Error('Git workers only inspect supported configuration names.')
  if (
    operation === 'config' &&
    !args
      .slice(index + 1)
      .some((arg) =>
        ['--get', '--get-all', '--get-regexp', '--list'].includes(arg),
      )
  )
    throw new Error('Git workers only inspect repository configuration.')
  return [
    ...prefix,
    ...args.slice(0, index),
    ...(!credentialReset ? ['-c', 'credential.helper='] : []),
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.editor=/bin/false',
    '-c',
    'core.pager=cat',
    ...args.slice(index),
  ]
}
