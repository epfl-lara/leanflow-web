// Match repository links and clone URLs without sharing access with other paths
// on the same host. GitHub and GitLab folder links identify their parent repo.
export function repositoryConnectionKey(value) {
  if (typeof value !== 'string' || /[\s\\]|\p{Cc}/u.test(value)) return ''
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return ''
    let pathname = url.pathname.replace(/\/+$/, '')
    if (url.hostname === 'github.com') {
      const parts = pathname.split('/')
      if (parts[3] === 'tree') pathname = parts.slice(0, 3).join('/')
      pathname = pathname.toLowerCase()
    }
    const folder = pathname.indexOf('/-/tree/')
    if (folder !== -1) pathname = pathname.slice(0, folder)
    pathname = pathname.replace(/\.git$/, '')
    return pathname && pathname !== '/' ? url.origin + pathname : ''
  } catch {
    return ''
  }
}
