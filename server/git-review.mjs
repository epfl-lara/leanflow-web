import { validateGitBranch } from './git-branches.mjs'

const PROVIDERS = new Set(['github', 'gitlab', 'other'])

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 })
}

function repositoryPage(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    return null
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1)
  if (!parts.length) return null
  const decoded = []
  for (const part of parts) {
    let name
    try {
      name = decodeURIComponent(part)
    } catch {
      return null
    }
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      /[/\\?#%]/.test(name) ||
      [...name].some(
        (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
      )
    )
      return null
    decoded.push(name)
  }
  const last = decoded.at(-1).replace(/\.git$/, '')
  if (!last || last === '.' || last === '..') return null
  decoded[decoded.length - 1] = last
  url.pathname = '/' + decoded.map(encodeURIComponent).join('/')
  return { url, parts: decoded }
}

export function gitReviewProvider(remoteUrl, selected) {
  if (selected !== undefined && !PROVIDERS.has(selected))
    fail('Choose GitHub, GitLab, or another Git host.')
  const page = repositoryPage(remoteUrl)
  if (selected === 'other') return 'other'
  const inferred =
    page?.url.hostname === 'github.com'
      ? 'github'
      : page?.url.hostname === 'gitlab.com'
        ? 'gitlab'
        : 'other'
  const provider = selected || inferred
  if (
    provider !== 'other' &&
    (!page ||
      (provider === 'github' ? page.parts.length !== 2 : page.parts.length < 2))
  ) {
    if (selected)
      fail('Use the repository HTTPS clone URL for the selected Git host.')
    return 'other'
  }
  return provider
}

// These links open the provider's review form. They never create a review or
// receive the one-use push credential.
export function gitReviewLink({ remoteUrl, provider, branch, baseBranch }) {
  provider = gitReviewProvider(remoteUrl, provider)
  if (provider === 'other') return undefined
  validateGitBranch(branch)
  if (baseBranch) validateGitBranch(baseBranch)
  if (baseBranch === branch) return undefined
  const page = repositoryPage(remoteUrl)
  const url = page.url
  if (provider === 'github') {
    const comparison = baseBranch
      ? `${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}`
      : encodeURIComponent(branch)
    url.pathname += '/compare/' + comparison
    url.searchParams.set('quick_pull', '1')
    return {
      kind: 'pull-request',
      label: 'Open pull request on GitHub',
      url: url.href,
    }
  }
  url.pathname += '/-/merge_requests/new'
  url.searchParams.set('merge_request[source_branch]', branch)
  if (baseBranch)
    url.searchParams.set('merge_request[target_branch]', baseBranch)
  return {
    kind: 'merge-request',
    label: 'Open merge request on GitLab',
    url: url.href,
  }
}

export function suggestedPublishBranch(projectId, now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10)
  const suffix = String(projectId)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8)
  return `leanflow/${date}-${suffix || 'changes'}`
}
