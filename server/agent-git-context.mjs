import { gitHttpsArgs, gitHttpsEnv } from './git-credentials.mjs'

const hash = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/

function repositoryUrl(value) {
  if (typeof value !== 'string' || /\p{Cc}|\s/u.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port || url.search || url.hash)
      return null
    // A manually configured remote must not copy an embedded token into chat.
    url.username = ''
    url.password = ''
    return url.href
  } catch {
    return null
  }
}

// Read only the saved checkout. No project Git configuration or history is
// copied into the writable agent candidate, including for local-only commits.
export async function captureAgentGitContext({
  runtime,
  root,
  repository,
  subdirectory = '',
  sourceRevision,
  signal,
  assertAuthorized = () => {},
}) {
  const run = async (args, { optional = false } = {}) => {
    signal?.throwIfAborted()
    assertAuthorized()
    const result = await (runtime.runGit || runtime.run).call(
      runtime,
      root,
      [...gitHttpsArgs, '--no-optional-locks', ...args],
      {
        signal,
        env: gitHttpsEnv,
        network: 'none',
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        readOnlyWorkspace: true,
        readOnlyHome: true,
        freshHome: true,
        cleanHome: true,
        queue: false,
      },
    )
    signal?.throwIfAborted()
    assertAuthorized()
    if (result.truncated || result.stdout.length > 64 * 1024)
      throw new Error('Saved Git context is too large to read completely.')
    if (result.code !== 0 && !optional)
      throw new Error('Saved Git context could not be read.')
    return result.code === 0 ? result.stdout : null
  }

  const status = await run([
    '--literal-pathspecs',
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=normal',
    '-z',
    '--',
    subdirectory || '.',
  ])
  const headers = new Map()
  let trackedChanges = 0,
    untrackedEntries = 0,
    skipRenameSource = false
  for (const record of status.split('\0')) {
    if (skipRenameSource) {
      skipRenameSource = false
      continue
    }
    if (record.startsWith('# ')) {
      const space = record.indexOf(' ', 2)
      headers.set(record.slice(2, space), record.slice(space + 1))
    } else if (/^[12u] /.test(record)) {
      trackedChanges++
      skipRenameSource = record.startsWith('2 ')
    } else if (record.startsWith('? ')) untrackedEntries++
  }
  const oid = headers.get('branch.oid')
  const revision = hash.test(oid || '') ? oid : null
  if (sourceRevision && revision !== sourceRevision)
    throw new Error('Saved Git history changed after the source was captured.')
  const branch = headers.get('branch.head')
  const aheadBehind = /^\+(\d+) -(\d+)$/.exec(headers.get('branch.ab') || '')
  const history = revision
    ? await run([
        'log',
        '-20',
        '--no-show-signature',
        '-z',
        '--format=%H%x00%s',
        'HEAD',
      ])
    : ''
  const fields = history.split('\0')
  const commits = []
  for (let index = 0; index < fields.length - 1; index += 2) {
    if (!hash.test(fields[index]))
      throw new Error('Saved Git history could not be read completely.')
    commits.push({
      sha: fields[index],
      message: fields[index + 1].slice(0, 2000),
    })
  }
  if (revision && commits[0]?.sha !== revision)
    throw new Error('Saved Git history changed while its context was read.')
  const origin = repositoryUrl(repository)
    ? null
    : await run(['config', '--get', 'remote.origin.url'], { optional: true })
  return {
    kind: 'git',
    repository: repositoryUrl(repository) || repositoryUrl(origin?.trim()),
    sourceRevision: revision,
    currentBranch: branch && branch !== '(detached)' ? branch : null,
    subdirectory,
    upstream: headers.get('branch.upstream') || null,
    upstreamFreshness: 'Locally cached; no remote fetch was performed.',
    ...(aheadBehind
      ? { ahead: Number(aheadBehind[1]), behind: Number(aheadBehind[2]) }
      : {}),
    trackedChanges,
    untrackedEntries,
    commits,
    historyLimit: 20,
    checkout: 'Source-only candidate; saved Git history is reference data.',
  }
}
