import { repositoryConnectionKey } from '../shared/git-connections.mjs'

// Only explicit user messages can authorize another repository to use a saved
// host connection. File contents, commit messages and assistant replies cannot.
export function requestedGitRepositories(request) {
  const repositories = new Set()
  const texts = [
    request?.prompt,
    ...(Array.isArray(request?.followups) ? request.followups : [])
      .filter((entry) => ['pending', 'accepted'].includes(entry.status))
      .map((entry) => entry.text),
  ]
  for (const text of texts) {
    if (typeof text !== 'string') continue
    for (const match of text.matchAll(/https:\/\/[^\s<>"`()[\],;]+/g)) {
      const key = repositoryConnectionKey(match[0].replace(/\.+$/, ''))
      if (key) repositories.add(key)
    }
  }
  return [...repositories]
}
