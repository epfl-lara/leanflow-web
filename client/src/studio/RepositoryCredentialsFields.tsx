export type RepositoryCredentials = {
  repositoryToken?: string
  repositoryUsername?: string
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
}: {
  idPrefix: string
  token: string
  username: string
  onTokenChange: (value: string) => void
  onUsernameChange: (value: string) => void
  disabled?: boolean
  required?: boolean
  autoFocus?: boolean
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
        matching username if your token requires it. The token is used only for
        this import, then cleared. It is not saved as a connection. Imports
        using a token download the full repository history.
      </p>
    </>
  )
}
