import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, errorText, post, type GitInfo, type Project } from './api'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { GitDiff } from './GitDiff'
import './git.css'

interface PushPreview {
  previewId: string
  head: string
  branch: string
  remoteUrl: string
  commits: { sha: string; message: string }[]
  historyCount: number
  uncommittedCount: number
}
const headOf = (info: GitInfo | null) => info?.revision || info?.head || null
const namedBranch = (branch?: string | null) =>
  !!branch &&
  branch !== 'HEAD' &&
  !branch.startsWith('HEAD ') &&
  !branch.startsWith('(HEAD')

export function GitModal({
  project,
  initialInfo,
  dirty,
  localBlockedReason,
  onSave,
  onUpdated,
  onClose,
}: {
  project: Project
  initialInfo: GitInfo | null
  dirty: boolean
  localBlockedReason?: string
  onSave: () => Promise<void>
  onUpdated: (info: GitInfo) => void
  onClose: () => void
}) {
  const [info, setInfo] = useState(initialInfo)
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<'changes' | 'publish'>('changes')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [authorOpen, setAuthorOpen] = useState(false)
  const [authorName, setAuthorName] = useState('')
  const [authorEmail, setAuthorEmail] = useState('')
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState(initialInfo?.remoteUrl || '')
  const [targetBranch, setTargetBranch] = useState(
    namedBranch(initialInfo?.branch) ? initialInfo!.branch! : '',
  )
  const [preview, setPreview] = useState<PushPreview | null>(null)
  const previewRef = useRef(preview)
  const previewSourceBranch = useRef<string | null>(null)
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const mounted = useRef(true)
  const busyRef = useRef(busy)
  const refreshing = useRef(false)
  const request = useRef(0)
  const destinationTouched = useRef(false)
  busyRef.current = busy
  previewRef.current = preview
  const endpoint = `/api/projects/${encodeURIComponent(project.id)}/git`
  const blockedReason =
    localBlockedReason ||
    (info?.mutationBlocked
      ? info.blockedReason ||
        'Finish or stop active Lean checks and Lemex runs first.'
      : '')
  const locked = !loaded || !!busy || !!blockedReason

  const acceptInfo = useCallback(
    (value: GitInfo) => {
      if (!mounted.current) return
      setInfo(value)
      setLoaded(true)
      onUpdated(value)
      setSelected((previous) =>
        value.changes?.some((item) => item.path === previous)
          ? previous
          : value.changes?.[0]?.path || null,
      )
      if (!destinationTouched.current) {
        setRemoteUrl(value.remoteUrl || '')
        setTargetBranch(namedBranch(value.branch) ? value.branch! : '')
      }
      if (
        previewRef.current &&
        (previewRef.current.head !== headOf(value) ||
          previewSourceBranch.current !== value.branch)
      ) {
        setPreview(null)
        setToken('')
        setUsername('')
        setNotice(
          'The local commit or branch changed. Preview the push again before publishing.',
        )
      }
    },
    [onUpdated],
  )
  const refresh = useCallback(async () => {
    const id = ++request.current
    refreshing.current = true
    try {
      const value = await api<GitInfo>(endpoint)
      if (mounted.current && id === request.current) acceptInfo(value)
      return value
    } finally {
      if (id === request.current) refreshing.current = false
    }
  }, [endpoint, acceptInfo])
  useEffect(() => {
    mounted.current = true
    void refresh().catch((error) => {
      if (mounted.current) setError(errorText(error))
    })
    const timer = setInterval(() => {
      if (!busyRef.current && !refreshing.current)
        void refresh().catch((error) => {
          if (mounted.current) setError(errorText(error))
        })
    }, 4000)
    return () => {
      mounted.current = false
      ++request.current
      clearInterval(timer)
    }
  }, [refresh])

  const resetPreview = () => {
    setPreview(null)
    setToken('')
    setUsername('')
  }
  async function saveAndRefresh() {
    if (locked) return
    setBusy('Saving editor')
    setError('')
    setNotice('')
    resetPreview()
    try {
      await onSave()
      await refresh()
      if (mounted.current)
        setNotice('Editor saved. Review the updated changes before committing.')
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) setBusy('')
    }
  }
  async function commit(event: FormEvent) {
    event.preventDefault()
    if (locked || !commitMessage.trim()) return
    if (dirty) {
      await saveAndRefresh()
      return
    }
    const reviewToken = info?.reviewToken
    if (!reviewToken) {
      setError('Refresh the saved changes before committing.')
      return
    }
    setBusy('Committing')
    setError('')
    setNotice('')
    resetPreview()
    try {
      await onSave()
      const value = await post<GitInfo>(endpoint, {
        action: 'commit',
        message: commitMessage.trim(),
        reviewToken,
        ...(authorName.trim() ? { authorName: authorName.trim() } : {}),
        ...(authorEmail.trim() ? { authorEmail: authorEmail.trim() } : {}),
      })
      if (!mounted.current) return
      acceptInfo(value)
      setCommitMessage('')
      setNotice('Saved project changes committed.')
      await refresh()
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) setBusy('')
    }
  }
  async function createBranch(event: FormEvent) {
    event.preventDefault()
    if (locked || !branchName.trim()) return
    setBusy('Creating branch')
    setError('')
    setNotice('')
    resetPreview()
    try {
      const value = await post<GitInfo>(endpoint, {
        action: 'branch',
        name: branchName.trim(),
      })
      if (!mounted.current) return
      acceptInfo(value)
      destinationTouched.current = false
      setTargetBranch(value.branch || '')
      setBranchName('')
      setBranchOpen(false)
      setNotice(`Switched to ${value.branch || 'the new branch'}.`)
      await refresh()
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) setBusy('')
    }
  }
  async function previewPush(event: FormEvent) {
    event.preventDefault()
    if (
      locked ||
      !namedBranch(info?.branch) ||
      !remoteUrl.trim() ||
      !targetBranch.trim()
    )
      return
    setBusy('Preparing push preview')
    setError('')
    setNotice('')
    resetPreview()
    try {
      const value = await post<PushPreview>(endpoint, {
        action: 'preview-push',
        remoteUrl: remoteUrl.trim(),
        branch: targetBranch.trim(),
      })
      if (mounted.current) {
        previewSourceBranch.current = info?.branch || null
        setPreview(value)
      }
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) setBusy('')
    }
  }
  async function publish(event: FormEvent) {
    event.preventDefault()
    if (locked || !preview || !token.trim()) return
    const reviewed = preview
    const credential = token.trim(),
      login = username.trim()
    setBusy('Publishing reviewed commit')
    setError('')
    setNotice('')
    // Remove the token from the controlled input as soon as the one-use request begins.
    setToken('')
    setUsername('')
    try {
      const value = await post<{
        pushed: boolean
        head: string
        branch: string
        remoteUrl: string
        warning?: string
      }>(endpoint, {
        action: 'push',
        previewId: reviewed.previewId,
        token: credential,
        ...(login ? { username: login } : {}),
      })
      if (!mounted.current) return
      if (!value.pushed)
        throw new Error('The repository did not confirm the push.')
      setNotice(
        `Published ${value.head.slice(0, 12)} to ${value.branch}.${value.warning ? ` ${value.warning}` : ''}`,
      )
      await refresh().catch(() => {
        if (mounted.current)
          setError(
            'Published successfully. Refresh Source control to load the current status.',
          )
      })
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) {
        setPreview(null)
        setToken('')
        setUsername('')
        setBusy('')
      }
    }
  }

  return (
    <Dialog title="Source control" subtitle={project.name} onClose={onClose}>
      <div className="git-workbench">
        <div className="git-toolbar">
          <span>
            <Icon name="git" size={15} />
            {namedBranch(info?.branch) ? info?.branch : 'Detached HEAD'}
          </span>
          <code title={headOf(info) || undefined}>
            {headOf(info)?.slice(0, 12) || 'No commits yet'}
          </code>
          <button
            className="button subtle small"
            type="button"
            disabled={!!busy}
            onClick={() => {
              setError('')
              void refresh().catch((error) => setError(errorText(error)))
            }}
          >
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        </div>
        <div
          className="git-tabs"
          role="tablist"
          aria-label="Source control view"
        >
          {(['changes', 'publish'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`git-tab-${value}`}
              aria-selected={tab === value}
              aria-controls={`git-${value}`}
              tabIndex={tab === value ? 0 : -1}
              disabled={!!busy}
              onClick={() => {
                setTab(value)
                setError('')
                if (value === 'changes') {
                  setToken('')
                  setUsername('')
                }
              }}
              onKeyDown={(event) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                    event.key,
                  )
                )
                  return
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 'changes'
                    : event.key === 'End'
                      ? 'publish'
                      : value === 'changes'
                        ? 'publish'
                        : 'changes'
                setTab(next)
                setToken('')
                setUsername('')
                document.getElementById(`git-tab-${next}`)?.focus()
              }}
            >
              {value === 'changes' ? 'Changes' : 'Publish'}
            </button>
          ))}
        </div>
        {blockedReason && <p className="git-blocked">{blockedReason}</p>}
        {busy && (
          <output className="git-progress">
            <span className="spinner" />
            {busy}…
            <span>You can close this view while the operation continues.</span>
          </output>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {notice && <output className="git-notice">{notice}</output>}
        {!loaded && !error && (
          <p className="git-empty">Loading saved source-control state…</p>
        )}
        {tab === 'changes' ? (
          <div
            id="git-changes"
            className="git-changes-view"
            role="tabpanel"
            aria-labelledby="git-tab-changes"
          >
            <div className="git-changes-heading">
              <strong>{info?.changes?.length || 0} saved changes</strong>
              {dirty && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={locked}
                  onClick={() => void saveAndRefresh()}
                >
                  Save and refresh
                </button>
              )}
            </div>
            {dirty && (
              <p className="field-help">
                The editor has unsaved changes. Save it to include those changes
                in this review.
              </p>
            )}
            {!!info?.changes?.length && (
              <ul className="git-file-list" aria-label="Changed project files">
                {info.changes.map((change) => (
                  <li key={change.path}>
                    <button
                      type="button"
                      aria-pressed={selected === change.path}
                      className={selected === change.path ? 'selected' : ''}
                      onClick={() => setSelected(change.path)}
                    >
                      <code className="git-file-status">
                        {change.status === '??' ? 'New' : change.status.trim()}
                      </code>
                      <span title={change.path}>
                        {change.from
                          ? `${change.from} → ${change.path}`
                          : change.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {info && (
              <GitDiff projectId={project.id} info={info} selected={selected} />
            )}
            <form className="git-commit-form" onSubmit={commit}>
              <label className="field-label" htmlFor="git-commit-message">
                Commit message
              </label>
              <textarea
                id="git-commit-message"
                value={commitMessage}
                maxLength={2000}
                rows={2}
                placeholder="Describe the changes you reviewed"
                onChange={(event) => setCommitMessage(event.target.value)}
                disabled={locked}
              />
              <p className="field-help">
                Commits eligible saved project files. Private files and
                dependencies are excluded. Existing unrelated staged files stay
                outside this commit.
              </p>
              <details
                className="git-author-section"
                open={authorOpen}
                onToggle={(event) => {
                  if (event.target === event.currentTarget)
                    setAuthorOpen(event.currentTarget.open)
                }}
              >
                <summary>
                  Commit author{info?.author ? ` · ${info.author.name}` : ''}
                </summary>
                {authorOpen && (
                  <>
                    {info?.author && (
                      <p className="field-help">
                        Default: {info.author.name} &lt;{info.author.email}&gt;
                      </p>
                    )}
                    <div className="git-author-fields">
                      <label>
                        Author name
                        <input
                          value={authorName}
                          onChange={(event) =>
                            setAuthorName(event.target.value)
                          }
                          placeholder={
                            info?.author?.name || 'Use default author'
                          }
                          disabled={locked}
                          maxLength={200}
                        />
                      </label>
                      <label>
                        Author email
                        <input
                          type="email"
                          value={authorEmail}
                          onChange={(event) =>
                            setAuthorEmail(event.target.value)
                          }
                          placeholder={
                            info?.author?.email || 'Use default email'
                          }
                          disabled={locked}
                          maxLength={254}
                        />
                      </label>
                    </div>
                    <p className="field-help">
                      Optional, for this commit. Use your repository account
                      email or its no-reply address to link the commit to your
                      profile.
                    </p>
                  </>
                )}
              </details>
              <button
                className="button primary"
                disabled={
                  locked ||
                  !commitMessage.trim() ||
                  !info?.reviewToken ||
                  (!dirty && !info?.changes?.length)
                }
              >
                {busy === 'Committing' ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="git" size={15} />
                )}
                {dirty ? 'Save and review changes' : 'Commit saved changes'}
              </button>
            </form>
            <details
              className="git-branch-section"
              open={branchOpen}
              onToggle={(event) => {
                if (event.target === event.currentTarget)
                  setBranchOpen(event.currentTarget.open)
              }}
            >
              <summary>Create branch</summary>
              {branchOpen && (
                <form onSubmit={createBranch}>
                  <label className="field-label" htmlFor="git-branch-name">
                    Branch name
                  </label>
                  <div className="git-inline-form">
                    <input
                      id="git-branch-name"
                      value={branchName}
                      onChange={(event) => setBranchName(event.target.value)}
                      placeholder="proof/my-theorem"
                      disabled={locked}
                      maxLength={121}
                    />
                    <button
                      className="button secondary"
                      disabled={locked || !branchName.trim()}
                    >
                      Create branch
                    </button>
                  </div>
                  <p className="field-help">
                    Creates a new branch and switches this project to it.
                  </p>
                </form>
              )}
            </details>
          </div>
        ) : (
          <div
            id="git-publish"
            className="git-publish-view"
            role="tabpanel"
            aria-labelledby="git-tab-publish"
          >
            {!namedBranch(info?.branch) && (
              <p className="git-blocked">
                Create a local branch before publishing.{' '}
                <button
                  type="button"
                  className="git-text-button"
                  disabled={!!busy}
                  onClick={() => {
                    setTab('changes')
                    setBranchOpen(true)
                  }}
                >
                  Create branch
                </button>
              </p>
            )}
            <form onSubmit={previewPush} autoComplete="off">
              <label className="field-label" htmlFor="git-remote-url">
                Repository URL
              </label>
              <input
                id="git-remote-url"
                type="url"
                value={remoteUrl}
                placeholder="https://github.com/owner/repository.git"
                disabled={locked}
                onChange={(event) => {
                  destinationTouched.current = true
                  setRemoteUrl(event.target.value)
                  resetPreview()
                }}
              />
              <label className="field-label" htmlFor="git-target-branch">
                Target branch
              </label>
              <input
                id="git-target-branch"
                value={targetBranch}
                placeholder="main"
                disabled={locked}
                onChange={(event) => {
                  destinationTouched.current = true
                  setTargetBranch(event.target.value)
                  resetPreview()
                }}
              />
              <p className="field-help">
                Use a public HTTPS repository address. You need permission to
                push to its target branch.
              </p>
              <button
                className="button secondary"
                disabled={
                  locked ||
                  !headOf(info) ||
                  !namedBranch(info?.branch) ||
                  !remoteUrl.trim() ||
                  !targetBranch.trim()
                }
              >
                {busy === 'Preparing push preview' && (
                  <span className="spinner" />
                )}
                Preview push
              </button>
            </form>
            {preview && (
              <section className="git-push-preview" aria-label="Reviewed push">
                <h3>Review before publishing</h3>
                <dl>
                  <div>
                    <dt>Destination</dt>
                    <dd>{preview.remoteUrl}</dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>{preview.branch}</dd>
                  </div>
                  <div>
                    <dt>Commit</dt>
                    <dd>
                      <code>{preview.head}</code>
                    </dd>
                  </div>
                </dl>
                <p>
                  This publishes the reviewed commit and its existing committed
                  history to the destination. {preview.historyCount} commit
                  {preview.historyCount === 1 ? '' : 's'} in its history.
                </p>
                <p className="field-help">
                  Recent commits below describe local history; they are not a
                  list of commits missing from the remote. Saved uncommitted
                  changes and unsaved editor changes are excluded from this
                  push.
                </p>
                {preview.uncommittedCount > 0 && (
                  <p className="git-blocked">
                    {preview.uncommittedCount} saved working-tree change
                    {preview.uncommittedCount === 1 ? ' is' : 's are'} not
                    included.
                  </p>
                )}
                <ul
                  className="git-commit-list"
                  aria-label="Recent local commits"
                >
                  {preview.commits.map((item) => (
                    <li key={item.sha}>
                      <code title={item.sha}>{item.sha.slice(0, 9)}</code>
                      <span>{item.message}</span>
                    </li>
                  ))}
                </ul>
                <form onSubmit={publish} autoComplete="off">
                  <label className="field-label" htmlFor="git-repository-token">
                    Repository token
                  </label>
                  <input
                    id="git-repository-token"
                    name="repository-publish-token"
                    type="password"
                    value={token}
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={locked}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <label className="field-label" htmlFor="git-publish-username">
                    Username <span className="git-optional">optional</span>
                  </label>
                  <input
                    id="git-publish-username"
                    value={username}
                    autoComplete="off"
                    disabled={locked}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="Repository account username"
                  />
                  <p className="field-help">
                    The token is used once for this push, then cleared. It is
                    not saved or sent to Lemex. The server checks the reviewed
                    commit again before publishing.
                  </p>
                  <button
                    className="button primary"
                    disabled={locked || !token.trim()}
                  >
                    Publish reviewed commit
                  </button>
                </form>
              </section>
            )}
            {!headOf(info) && (
              <p className="git-empty">
                Create your first commit before previewing a push.
              </p>
            )}
          </div>
        )}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
      </footer>
    </Dialog>
  )
}
