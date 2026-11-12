import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  api,
  errorText,
  type Project,
  type ProjectSharing,
  type ProjectAccessRole,
} from './api'
import { CopyButton } from './CopyButton'
import { Dialog } from './Dialog'

const roleLabel = (role: string) =>
  role === 'editor' ? 'Editor' : role === 'admin' ? 'Admin' : 'Viewer'
const sharingError = (error: unknown) =>
  error instanceof DOMException && error.name === 'TimeoutError'
    ? 'The server took too long to respond. Try again.'
    : error instanceof TypeError && /fetch|network|load/i.test(error.message)
      ? 'Could not reach the server. Check your connection and try again.'
      : errorText(error)

export function ProjectSharingDialog({
  project,
  currentUserId,
  onClose,
  onChanged,
}: {
  project: Project
  currentUserId: string
  onClose: () => void
  onChanged?: () => Promise<void>
}) {
  const base = `/api/projects/${encodeURIComponent(project.id)}/sharing`
  const [sharing, setSharing] = useState<ProjectSharing | null>(null)
  const [query, setQuery] = useState('')
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [busy, setBusy] = useState(false)
  const updating = useRef(false)
  const operation = useRef(0)
  const [attempt, setAttempt] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [roleDrafts, setRoleDrafts] = useState<
    Record<string, ProjectAccessRole>
  >({})
  const [accessChange, setAccessChange] = useState<{
    userId: string
    name: string
    role: ProjectAccessRole | null
  } | null>(null)
  const soleAdminNote = useId()
  const [error, setError] = useState('')
  const [adminConfirmed, setAdminConfirmed] = useState(false)
  const [links, setLinks] = useState<Record<string, string>>({})
  const soleAdmin =
    sharing?.members.filter((member) => member.role === 'admin').length === 1

  useEffect(() => {
    const controller = new AbortController()
    void api<ProjectSharing>(base, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then(setSharing)
      .catch((error) => {
        if (!controller.signal.aborted) setError(sharingError(error))
      })
    return () => controller.abort()
  }, [base, attempt])

  useEffect(() => {
    setAccounts([])
    setSearched(false)
    if (query.trim().length < 2) {
      setSearching(false)
      return
    }
    const controller = new AbortController()
    setSearching(true)
    const timer = setTimeout(() => {
      void api<{ id: string; name: string }[]>(
        `/api/accounts/search?q=${encodeURIComponent(query.trim())}`,
        { signal: controller.signal },
      )
        .then((values) => {
          setAccounts(values)
          setSearched(true)
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(sharingError(error))
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  async function update(
    message: string,
    action: (signal: AbortSignal) => Promise<unknown>,
    refresh = true,
  ) {
    if (updating.current) return
    updating.current = true
    const revision = ++operation.current
    setBusy(true)
    setError('')
    setFeedback('Updating project access…')
    try {
      const signal = AbortSignal.timeout(15000)
      await action(signal)
      void onChanged?.().catch((error) => {
        if (operation.current === revision) setError(sharingError(error))
      })
      if (refresh) setSharing(await api<ProjectSharing>(base, { signal }))
      setFeedback(message)
    } catch (error) {
      setError(sharingError(error))
      try {
        setSharing(
          await api<ProjectSharing>(base, {
            signal: AbortSignal.timeout(10000),
          }),
        )
        setFeedback(
          'The saved access list has been refreshed. Check it before retrying.',
        )
      } catch {
        setFeedback(
          'The change may have finished. Reload access before retrying.',
        )
      }
    } finally {
      updating.current = false
      setBusy(false)
    }
  }

  async function assignMember(userId: string, selected: ProjectAccessRole) {
    if (selected === 'admin' && !adminConfirmed) {
      setError(
        'Confirm that this account may change sharing and delete the project before granting Admin access.',
      )
      return
    }
    const previous = sharing?.members.find((member) => member.userId === userId)
    const rank = { viewer: 0, editor: 1, admin: 2 }
    if (previous && rank[selected] < rank[previous.role]) {
      setAccessChange({ userId, name: previous.name || userId, role: selected })
      return
    }
    await applyMember(userId, selected)
  }

  async function applyMember(userId: string, selected: ProjectAccessRole) {
    if (selected === 'admin') setAdminConfirmed(false)
    await update(
      'Project access updated.',
      (signal) =>
        api(`${base}/members/${encodeURIComponent(userId)}`, {
          method: 'PUT',
          body: JSON.stringify({ role: selected }),
          signal,
        }),
      userId !== currentUserId || selected === 'admin',
    )
    setRoleDrafts((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) => id !== userId),
      ),
    )
  }

  async function removeMember(userId: string) {
    await update(
      'Account removed from this project.',
      (signal) =>
        api(`${base}/members/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
          body: JSON.stringify({}),
          signal,
        }),
      userId !== currentUserId,
    )
  }

  async function createLink(event: FormEvent) {
    event.preventDefault()
    await update(
      'Share link created. Copy it before closing this dialog.',
      async (signal) => {
        const created = await api<
          ProjectSharing['links'][number] & { token: string }
        >(`${base}/links`, {
          method: 'POST',
          body: JSON.stringify({ role }),
          signal,
        })
        const url = new URL(window.location.href)
        url.hash = `share=${encodeURIComponent(created.token)}`
        setLinks((previous) => ({ ...previous, [created.id]: url.href }))
      },
    )
  }

  return (
    <Dialog
      title="Share project"
      subtitle={project.name}
      onClose={onClose}
      busy={busy}
    >
      <div className="project-sharing">
        <p className="field-help">
          Admins manage access and can delete this project.
        </p>
        <p className="field-help">
          Editors can edit files, run their own assistant, use the terminal,
          publish with Git, and prepare the project environment using their own
          credentials. Viewers can read and download files. Chats, API keys, and
          provider settings stay private to each account.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {feedback && <output className="field-help">{feedback}</output>}
        {error && sharing && (
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() => {
              setError('')
              setAttempt((value) => value + 1)
            }}
          >
            Reload access
          </button>
        )}
        {!sharing ? (
          <div>
            <output>
              {error
                ? 'Sharing could not load. Try again.'
                : 'Loading project access…'}
            </output>
            {error && (
              <button
                type="button"
                className="button small secondary"
                onClick={() => {
                  setError('')
                  setAttempt((value) => value + 1)
                }}
              >
                Retry sharing
              </button>
            )}
          </div>
        ) : (
          <>
            <section aria-label="People with access">
              <h3>People with access</h3>
              <div className="sharing-people">
                {sharing.members.map((member) => (
                  <div className="sharing-person" key={member.userId}>
                    <span className="sharing-person-name">
                      {member.name || member.userId}
                      {member.userId === currentUserId && <small>You</small>}
                    </span>
                    <select
                      aria-label={`Role for ${member.name || member.userId}`}
                      value={roleDrafts[member.userId] || member.role}
                      aria-describedby={
                        member.role === 'admin' && soleAdmin
                          ? soleAdminNote
                          : undefined
                      }
                      title={
                        member.role === 'admin' && soleAdmin
                          ? 'Keep at least one project admin.'
                          : undefined
                      }
                      disabled={busy || (member.role === 'admin' && soleAdmin)}
                      onChange={(event) => {
                        const selected = event.target.value
                        if (
                          selected === 'admin' ||
                          selected === 'editor' ||
                          selected === 'viewer'
                        )
                          setRoleDrafts((previous) => ({
                            ...previous,
                            [member.userId]: selected,
                          }))
                      }}
                    >
                      <option
                        value="admin"
                        disabled={member.role !== 'admin' && !adminConfirmed}
                      >
                        Admin
                      </option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    {roleDrafts[member.userId] &&
                      roleDrafts[member.userId] !== member.role && (
                        <button
                          type="button"
                          className="button small secondary"
                          aria-label={`Apply role for ${member.name || member.userId}`}
                          disabled={
                            busy ||
                            (member.role === 'admin' && soleAdmin) ||
                            (roleDrafts[member.userId] === 'admin' &&
                              !adminConfirmed)
                          }
                          onClick={() =>
                            void assignMember(
                              member.userId,
                              roleDrafts[member.userId],
                            )
                          }
                        >
                          Apply
                        </button>
                      )}
                    <button
                      className="button small subtle"
                      type="button"
                      disabled={busy || (member.role === 'admin' && soleAdmin)}
                      aria-label={`Remove ${member.name || member.userId}`}
                      onClick={() =>
                        setAccessChange({
                          userId: member.userId,
                          name: member.name || member.userId,
                          role: null,
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              {soleAdmin && (
                <p className="field-help" id={soleAdminNote}>
                  Keep at least one project admin.
                </p>
              )}
              {accessChange && (
                <div className="sharing-self-confirmation" role="alert">
                  <strong>
                    {accessChange.role
                      ? `Change ${accessChange.userId === currentUserId ? 'your' : accessChange.name + '’s'} access to ${roleLabel(accessChange.role)}?`
                      : `Remove ${accessChange.userId === currentUserId ? 'your' : accessChange.name + '’s'} access to this project?`}
                  </strong>
                  <p>
                    {accessChange.userId === currentUserId
                      ? accessChange.role
                        ? 'You will lose access to sharing and project deletion.'
                        : 'You will lose access to this project.'
                      : 'This changes their project access.'}{' '}
                    This ends the affected account’s terminal, assistant runs,
                    and Lean checks. Unsaved drafts remain in their browser for
                    download.
                  </p>
                  <div className="button-row">
                    <button
                      className="button small danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const { role: selected, userId } = accessChange
                        setAccessChange(null)
                        void (selected
                          ? applyMember(userId, selected)
                          : removeMember(userId))
                      }}
                    >
                      Confirm access change
                    </button>
                    <button
                      className="button small secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setRoleDrafts((previous) =>
                          Object.fromEntries(
                            Object.entries(previous).filter(
                              ([id]) => id !== accessChange.userId,
                            ),
                          ),
                        )
                        setAccessChange(null)
                      }}
                    >
                      Cancel access change
                    </button>
                  </div>
                </div>
              )}
              <label className="sharing-admin-confirmation">
                <input
                  type="checkbox"
                  checked={adminConfirmed}
                  disabled={busy}
                  onChange={(event) => setAdminConfirmed(event.target.checked)}
                  aria-label="Confirm admin permissions"
                />
                <span>
                  <strong>
                    Admins can change sharing and delete this project.
                  </strong>{' '}
                  I understand and want to grant Admin access to a named
                  account. Keep at least one admin.
                </span>
              </label>
              <label className="field-label" htmlFor="sharing-account-search">
                Find an account
              </label>
              <input
                id="sharing-account-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name…"
                maxLength={80}
                aria-describedby="sharing-account-help"
                disabled={busy}
              />
              <p id="sharing-account-help" className="field-help">
                Enter at least two characters of their account name.
              </p>
              {searching && (
                <p className="field-help" role="status">
                  Searching accounts…
                </p>
              )}
              {searched && !accounts.length && (
                <p className="field-help" role="status">
                  No matching accounts.
                </p>
              )}
              <div className="sharing-search-results">
                {accounts.map((account) => {
                  const member = sharing.members.find(
                    (member) => member.userId === account.id,
                  )
                  return (
                    <div className="sharing-person" key={account.id}>
                      <span className="sharing-person-name">
                        {account.name}
                      </span>
                      {member ? (
                        <span className="tag">{roleLabel(member.role)}</span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="button small secondary"
                            disabled={busy}
                            onClick={() =>
                              void assignMember(account.id, 'editor')
                            }
                          >
                            Add editor
                          </button>
                          <button
                            type="button"
                            className="button small subtle"
                            disabled={busy}
                            onClick={() =>
                              void assignMember(account.id, 'viewer')
                            }
                          >
                            Add viewer
                          </button>
                          <button
                            type="button"
                            className="button small subtle"
                            disabled={busy || !adminConfirmed}
                            onClick={() =>
                              void assignMember(account.id, 'admin')
                            }
                          >
                            Add admin
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
            <section aria-label="Share links">
              <h3>Share links</h3>
              <p className="field-help">
                Anyone with a link can join after signing in. Copy a new link
                before closing this dialog. Revoking a link prevents new joins;
                remove people above to end their access.
              </p>
              <form className="sharing-link-form" onSubmit={createLink}>
                <select
                  aria-label="New share link role"
                  value={role}
                  disabled={busy}
                  onChange={(event) =>
                    setRole(
                      event.target.value === 'viewer' ? 'viewer' : 'editor',
                    )
                  }
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  className="button small secondary"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? 'Updating…' : 'Create share link'}
                </button>
              </form>
              <div className="sharing-links">
                {sharing.links.map((link) => (
                  <div className="sharing-link" key={link.id}>
                    <div className="sharing-person">
                      <span className="sharing-person-name">
                        {roleLabel(link.role)} link{' '}
                        <small>
                          {new Date(link.createdAt).toLocaleDateString()}
                        </small>
                      </span>
                      <button
                        className="button small subtle"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void update(
                            'Share link revoked. Existing members keep their access.',
                            async (signal) => {
                              await api(
                                `${base}/links/${encodeURIComponent(link.id)}`,
                                {
                                  method: 'DELETE',
                                  body: JSON.stringify({}),
                                  signal,
                                },
                              )
                              setLinks((previous) =>
                                Object.fromEntries(
                                  Object.entries(previous).filter(
                                    ([id]) => id !== link.id,
                                  ),
                                ),
                              )
                            },
                          )
                        }
                      >
                        Revoke
                      </button>
                    </div>
                    {links[link.id] && (
                      <div className="sharing-link-copy">
                        <input
                          aria-label={`${roleLabel(link.role)} share link`}
                          readOnly
                          value={links[link.id]}
                          onFocus={(event) => event.target.select()}
                        />
                        <CopyButton text={links[link.id]} label="Copy link" />
                      </div>
                    )}
                    {!links[link.id] && (
                      <p className="field-help">
                        Create a new link if you need to copy it again.
                      </p>
                    )}
                  </div>
                ))}
                {!sharing.links.length && (
                  <p className="field-help">No active share links.</p>
                )}
              </div>
            </section>
          </>
        )}
      </div>
      <footer className="dialog-actions">
        <button
          className="button secondary"
          type="button"
          onClick={onClose}
          disabled={busy}
        >
          Done
        </button>
      </footer>
    </Dialog>
  )
}
