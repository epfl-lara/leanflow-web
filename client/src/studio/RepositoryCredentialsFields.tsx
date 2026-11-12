export type RepositoryCredentials = {
  repositoryToken?: string
  repositoryUsername?: string
}

export function RepositoryTokenSaveChoice({
  remember,
  onChange,
  disabled = false,
}: {
  remember: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <>
      <label className="setup-repair-choice">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
        />
        Save for this repository
      </label>
      <p className="field-help">
        {remember
          ? 'Saved for your account and reused for imports, pulls and pushes to this repository. Manage saved tokens in Git connections.'
          : 'Used once for this operation, then cleared.'}
      </p>
    </>
  )
}

export function RepositoryCredentialsFields({
  idPrefix,
  token,
  username,
  onTokenChange,
  onUsernameChange,
  disabled = false,
  required = false,
  autoFocus = false,
  remember = true,
  onRememberChange,
}: {
  idPrefix: string
  token: string
  username: string
  onTokenChange: (value: string) => void
  onUsernameChange: (value: string) => void
  disabled?: boolean
  required?: boolean
  autoFocus?: boolean
  remember?: boolean
  onRememberChange?: (value: boolean) => void
}) {
  const tokenId = `${idPrefix}-token`
  const usernameId = `${idPrefix}-username`
  const helpId = `${idPrefix}-help`
  return (
    <>
      <label className="field-label" htmlFor={tokenId}>
        Repository token {!required && <span>optional</span>}
      </label>
      <input
        id={tokenId}
        name={`${idPrefix}-access-token`}
        type="password"
        value={token}
        onChange={(event) => onTokenChange(event.target.value)}
        autoComplete="new-password"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        required={required}
        aria-describedby={helpId}
      />
      <label className="field-label" htmlFor={usernameId}>
        Repository username <span>optional</span>
      </label>
      <input
        id={usernameId}
        value={username}
        onChange={(event) => onUsernameChange(event.target.value)}
        placeholder="Usually unnecessary; required for deploy tokens"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-describedby={helpId}
      />
      <p className="field-help" id={helpId}>
        For private repositories, use a GitHub fine-grained token with Contents
        read access, or a GitLab token with read_repository access. Enter the
        matching username if your token requires it. To push changes later, the
        token also needs write access. Imports using a token download the full
        repository history.
      </p>
      {onRememberChange ? (
        <RepositoryTokenSaveChoice
          remember={remember}
          onChange={onRememberChange}
          disabled={disabled}
        />
      ) : (
        <p className="field-help">Used once for this import, then cleared.</p>
      )}
    </>
  )
}
