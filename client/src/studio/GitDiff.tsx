import { useEffect, useState } from 'react'
import { api, errorText, type GitInfo } from './api'

export function GitDiff({
  projectId,
  info,
  selected,
}: {
  projectId: string
  info: GitInfo
  selected: string | null
}) {
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const change = info.changes?.find((item) => item.path === selected)
  const untracked = change?.status === '??'
  const reviewVersion = info.reviewToken ?? info
  useEffect(() => {
    let cancelled = false
    setSource('')
    setError('')
    if (!selected || !untracked) {
      setLoading(false)
      return
    }
    setLoading(true)
    void api<{ content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(selected)}`,
    )
      .then((value) => {
        if (!cancelled) setSource(value.content)
      })
      .catch((error) => {
        if (!cancelled)
          setError(`Source preview unavailable: ${errorText(error)}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, selected, untracked, reviewVersion])
  if (!info.changes?.length)
    return <p className="git-empty">The saved working tree is clean.</p>
  const text = untracked ? source : info.diff || ''
  return (
    <section className="git-diff" aria-label="Saved changes diff">
      <div className="git-diff-caption">
        <strong>
          {untracked ? selected : 'Saved changes · all tracked files'}
        </strong>
        <span>
          {untracked ? 'New file · saved contents' : 'Full saved diff'}
        </span>
      </div>
      {loading ? (
        <p className="git-empty">Loading saved contents…</p>
      ) : error ? (
        <p className="git-empty">{error}</p>
      ) : !text ? (
        <p className="git-empty">
          No text diff is available. The file may be binary or a rename with
          unchanged contents.
        </p>
      ) : (
        <pre>
          {text
            .slice(0, 500_000)
            .split('\n')
            .map((line, index) => (
              <span
                key={index}
                className={
                  untracked || (line.startsWith('+') && !line.startsWith('+++'))
                    ? 'git-line added'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'git-line removed'
                      : 'git-line'
                }
              >
                {line || ' '}
              </span>
            ))}
        </pre>
      )}
      {text.length >= 500_000 && (
        <p className="git-empty">
          The preview is limited to 500,000 characters. Commits include the full
          eligible files.
        </p>
      )}
    </section>
  )
}
