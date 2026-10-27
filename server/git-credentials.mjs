import fs from 'node:fs/promises'
import path from 'node:path'
import { isIP } from 'node:net'

export async function gitHttpsDestination(
  value,
  { validateRepository, resolveHost },
) {
  let addresses = []
  const remoteUrl = await validateRepository(value, async (...args) => {
    const resolved = await resolveHost(...args)
    addresses = resolved.map((item) => item.address)
    return resolved
  })
  const hostname = new URL(remoteUrl).hostname
  if (!addresses.length) addresses = [hostname.replace(/^\[|\]$/g, '')]
  const selected =
    addresses.find((address) => isIP(address) === 4) || addresses[0]
  const pin = isIP(hostname.replace(/^\[|\]$/g, ''))
    ? []
    : [
        '-c',
        `http.curloptResolve=${hostname}:443:${isIP(selected) === 6 ? '[' + selected + ']' : selected}`,
      ]
  return { remoteUrl, pin }
}

// Keep HTTPS Git operations independent of host configuration, helpers and
// prompts. Credentials belong only to the Git subprocess, never its worker's
// command line, persistent environment, repository configuration or files.
export const gitHttpsEnv = Object.freeze({
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '0',
  GIT_TRACE: '0',
  GIT_TRACE_PACKET: '0',
  GIT_TRACE_CURL: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  NO_PROXY: '*',
})

export const gitHttpsArgs = Object.freeze([
  'git',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'http.followRedirects=false',
  '-c',
  'http.proxy=',
  '-c',
  'http.sslVerify=true',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
])

// Git runs helpers beginning with ! through its shell. The code and interpreter
// are fixed; credential values arrive only in the subprocess environment.
export const gitCredentialHelper = `!/usr/bin/python3 -c 'import os, sys
operation = sys.argv[1] if len(sys.argv) > 1 else ""
sys.stdin.read()
if operation == "get":
    print("username=" + os.environ.get("GIT_REPOSITORY_USERNAME", "x-access-token"))
    print("password=" + os.environ.get("GIT_REPOSITORY_TOKEN", ""))
'`

// The parent sends credentials over stdin only. A fixed credential helper works
// with read-only homes and noexec temporary mounts without writing any files.
export const gitCredentialsRunner = `import json, os, subprocess, sys
data = json.loads(sys.stdin.buffer.read(32769))
env = dict(os.environ)
env.pop('GIT_SSL_NO_VERIFY', None)
env.pop('GIT_REPOSITORY_USERNAME', None)
env.pop('GIT_REPOSITORY_TOKEN', None)
env.pop('GIT_ASKPASS', None)
command = sys.argv[1:]
is_git = command and os.path.basename(command[0]) == 'git'
if is_git and any(arg.startswith('http.curloptResolve=') for arg in command[1:]):
    support = subprocess.run([command[0], 'help', '--config'], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if support.returncode != 0 or b'http.curloptResolve' not in support.stdout:
        sys.exit('The Git worker cannot pin HTTPS destinations. Rebuild its image before using repository credentials.')
env['GIT_REPOSITORY_USERNAME'] = data.get('username') or 'x-access-token'
env['GIT_REPOSITORY_TOKEN'] = data.get('token') or ''
if is_git:
    helper = 'credential.helper=' + ${JSON.stringify(gitCredentialHelper)}
    for index in range(1, len(command) - 1):
        if command[index:index + 2] == ['-c', 'credential.helper=']:
            command[index + 2:index + 2] = ['-c', helper]
            break
    else:
        command[1:1] = ['-c', 'credential.helper=', '-c', helper]
sys.exit(subprocess.run(command, env=env, stdin=subprocess.DEVNULL).returncode)
`

export function validateGitCredentials(input = {}) {
  if (
    input.token !== undefined &&
    (typeof input.token !== 'string' ||
      input.token.length > 16_000 ||
      /[^\x21-\x7e]/.test(input.token))
  )
    throw Object.assign(new Error('Enter a valid one-use repository token.'), {
      status: 400,
    })
  if (
    input.username !== undefined &&
    (typeof input.username !== 'string' ||
      !/^[A-Za-z0-9._@+-]{1,200}$/.test(input.username))
  )
    throw Object.assign(new Error('Enter a valid repository username.'), {
      status: 400,
    })
  return {
    token: input.token || '',
    username: input.username || 'x-access-token',
  }
}

export function redactGitCredentials(value, credentials, redact = String) {
  let text = redact(String(value))
  if (credentials.token) {
    const secrets = [
      credentials.token,
      encodeURIComponent(credentials.token),
      encodeURI(credentials.token),
      Buffer.from(credentials.username + ':' + credentials.token).toString(
        'base64',
      ),
    ]
    for (const secret of [...new Set(secrets)].sort(
      (a, b) => b.length - a.length,
    ))
      text = text.split(secret).join('[redacted]')
  }
  return text
}

export function clearGitCredentials(credentials) {
  credentials.token = ''
}
export async function cleanupGitWorkerHome(worker, dataDir) {
  const home = worker?.workerHome
  if (
    !home ||
    path.dirname(home) !==
      path.join(path.resolve(dataDir), 'runtime', 'homes') ||
    !/^[a-f0-9]{64}$/.test(path.basename(home))
  )
    return
  await worker.workerStopped
  try {
    if ((await fs.realpath(home)) === path.resolve(home))
      await fs.rm(home, { recursive: true, force: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
