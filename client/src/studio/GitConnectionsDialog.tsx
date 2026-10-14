import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, errorText, type GitConnections, type GitProvider } from './api'
import { Dialog } from './Dialog'
import { gitConnectionsChanged, useGitConnections } from './gitConnections'
import './git.css'

function tokenSetupLink(provider: 'github' | 'gitlab', host: string) {
  const fallback =
    provider === 'github'
      ? 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens'
      : 'https://docs.gitlab.com/user/profile/personal_access_tokens/'
  try {
    const url = new URL(host.includes('://') ? host : `https://${host}`)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return fallback
    url.pathname =
      provider === 'github'
        ? '/settings/personal-access-tokens/new'
        : '/-/user_settings/personal_access_tokens'
    return url.href
  } catch {
    return fallback
  }
}

export function GitConnectionsDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged?: () => void
}) {
  const { data, error: loadError, loaded, refresh } = useGitConnections()
  const [provider, setProvider] = useState<GitProvider>('github')
  const [host, setHost] = useState('github.com')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef(false)
  const identityLoaded = useRef(false)
  useEffect(() => {
    if (data && !identityLoaded.current) {
      setName(data.identity.name)
      setEmail(data.identity.email)
      identityLoaded.current = true
    }
  }, [data])

  async function change(action: string, body?: object, removeHost?: string) {
    if (pending.current) return
    pending.current = true
    setBusy(action)
    setError('')
    setNotice('')
    // The request keeps the entered value only for its duration.
    setToken('')
    try {
      await api<GitConnections>(
        `/api/git-connections${removeHost ? `?host=${encodeURIComponent(removeHost)}` : ''}`,
        {
          method: removeHost ? 'DELETE' : 'PUT',
          body: JSON.stringify(body || {}),
        },
      )
      await refresh()
      gitConnectionsChanged()
      onChanged?.()
      setNotice(
        action === 'Removing connection'
          ? 'Connection removed. Future Git commands will require another connection or token.'
          : action === 'Saving author'
            ? 'Commit author saved for Source control and the terminal.'
            : 'Connection saved for imports, publishing and terminal Git commands.',
      )
    } catch (error) {
      setError(errorText(error))
    } finally {
      pending.current = false
      setBusy('')
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault()
    if (!token.trim() || !host.trim()) return
    void change('Saving connection', {
      action: 'connect',
      provider,
      host: host.trim(),
      token: token.trim(),
      ...(username.trim() ? { username: username.trim() } : {}),
    })
  }

  return (
    <Dialog
      title="Git connections"
      subtitle="One account setup for the interface and project terminal."
      onClose={onClose}
      busy={!!busy}
    >
      <div className="git-workbench git-connections">
        <p className="field-help">
          Connect the Git host you use, then clone, commit and publish from
          LeanFlow. The terminal uses the same saved connections for standard
          HTTPS Git commands. Run terminal commands only when you trust them to
          use that access.
        </p>
        {!loaded && <p className="field-help">Loading connections…</p>}
        {loaded && !data && !loadError && (
          <p role="alert" className="error-message">
            Saved Git connections are unavailable on this server. You can still
            provide a token for one import or push.
          </p>
        )}
        {(error || loadError) && (
          <p role="alert" className="error-message">
            {error || loadError}
          </p>
        )}
        {notice && <output className="git-notice">{notice}</output>}
        {!!data?.connections.length && (
          <ul className="git-connection-list" aria-label="Connected Git hosts">
            {data.connections.map((connection) => (
              <li key={connection.host}>
                <span>
                  <strong>{connection.host}</strong>
                  <small>{connection.username}</small>
                </span>
                <button
                  type="button"
                  className="button secondary small"
                  aria-label={`Disconnect ${connection.host}`}
                  disabled={!!busy}
                  onClick={() =>
                    void change(
                      'Removing connection',
                      undefined,
                      connection.host,
                    )
                  }
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={connect} autoComplete="off">
          <h3>Connect a Git host</h3>
          <label className="field-label" htmlFor="connection-provider">
            Provider
          </label>
          <select
            id="connection-provider"
            value={provider}
            disabled={!!busy}
            onChange={(event) => {
              const value = event.target.value
              if (value !== 'github' && value !== 'gitlab' && value !== 'other')
                return
              setProvider(value)
              setHost(
                value === 'github'
                  ? 'github.com'
                  : value === 'gitlab'
                    ? 'gitlab.com'
                    : '',
              )
              setToken('')
              setUsername('')
            }}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="other">Other</option>
          </select>
          <label className="field-label" htmlFor="connection-host">
            Git host
          </label>
          <input
            id="connection-host"
            value={host}
            required
            disabled={!!busy}
            autoComplete="off"
            placeholder="gitlab.example.org"
            onChange={(event) => {
              setHost(event.target.value)
              setToken('')
              setUsername('')
            }}
          />
          <label className="field-label" htmlFor="connection-token">
            Access token
          </label>
          <input
            id="connection-token"
            type="password"
            name="git-connection-access-token"
            autoComplete="new-password"
            spellCheck={false}
            required
            value={token}
            disabled={!!busy}
            onChange={(event) => setToken(event.target.value)}
          />
          <label className="field-label" htmlFor="connection-username">
            Username <span>optional</span>
          </label>
          <input
            id="connection-username"
            value={username}
            autoComplete="off"
            disabled={!!busy}
            placeholder="Needed for deploy tokens"
            onChange={(event) => setUsername(event.target.value)}
          />
          <p className="field-help">
            {provider === 'github' ? (
              <>
                Use a fine-grained token for the repositories you need, with{' '}
                <strong>Contents: Read and write</strong> to push, or{' '}
                <strong>Read-only</strong> to clone.
              </>
            ) : provider === 'gitlab' ? (
              <>
                Use a token with <strong>write_repository</strong> to push, or{' '}
                <strong>read_repository</strong> to clone. Enter its matching
                username for a deploy token used to clone.
              </>
            ) : (
              'Use a token with access to clone and push the repositories you need.'
            )}{' '}
            {provider !== 'other' && (
              <a
                href={tokenSetupLink(provider, host)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Create token on {provider === 'github' ? 'GitHub' : 'GitLab'}
              </a>
            )}
          </p>
          <p className="field-help">
            Saved for your account on this server. Tokens are never shown again.
            Replace a token by connecting the same host again, or disconnect it
            here. Revoke it at your Git host to invalidate it everywhere. Access
            is checked when you clone or push.
          </p>
          <button
            className="button primary"
            disabled={!!busy || !data || !host.trim() || !token.trim()}
          >
            {busy === 'Saving connection' && <span className="spinner" />}Save
            connection
          </button>
        </form>
        <details className="git-branch-section">
          <summary>
            Commit author{data?.identity.name ? ` · ${data.identity.name}` : ''}
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void change('Saving author', {
                action: 'identity',
                name: name.trim(),
                email: email.trim(),
              })
            }}
          >
            <p className="field-help">
              Used by Source control and terminal commits. Use your account
              email or no-reply address. Reopen an existing terminal to use an
              updated author.
            </p>
            <label className="field-label" htmlFor="connection-author-name">
              Author name
            </label>
            <input
              id="connection-author-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!!busy}
              maxLength={200}
              required
            />
            <label className="field-label" htmlFor="connection-author-email">
              Author email
            </label>
            <input
              id="connection-author-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={!!busy}
              maxLength={254}
              required
            />
            <button
              className="button secondary"
              disabled={!!busy || !data || !name.trim() || !email.trim()}
            >
              Save author
            </button>
          </form>
        </details>
      </div>
      <footer className="dialog-actions">
        <button
          type="button"
          className="button secondary"
          disabled={!!busy}
          onClick={onClose}
        >
          Close
        </button>
      </footer>
    </Dialog>
  )
}
