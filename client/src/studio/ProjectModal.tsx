import { useState, type FormEvent } from 'react'
import { Dialog } from './Dialog'
import {
  ProjectEnvironmentFields,
  useProjectEnvironment,
} from './ProjectEnvironmentFields'
import { UploadFiles, type UploadFile } from './UploadFiles'
import { Icon } from './Icons'
import { HelpTip } from './HelpTip'
import { RepositoryCredentialsFields } from './RepositoryCredentialsFields'
import { GitConnectionStatus } from './GitConnectionStatus'
import { repositoryHost, useGitConnections } from './gitConnections'
import { errorText, post, type Preset, type Project } from './api'

export function ProjectModal({
  templates,
  repairAvailable,
  initialPreset,
  onClose,
  onCreated,
  onOpenConnections,
}: {
  templates: Preset[]
  repairAvailable: boolean
  initialPreset?: string
  onClose: () => void
  onCreated: (project: Project) => void
  onOpenConnections?: () => void
}) {
  const [kind, setKind] = useState<'create' | 'import' | 'upload'>(
    initialPreset ? 'create' : 'import',
  )
  const [name, setName] = useState('')
  const [repository, setRepository] = useState('')
  const [repositoryToken, setRepositoryToken] = useState('')
  const [repositoryUsername, setRepositoryUsername] = useState('')
  const [revision, setRevision] = useState('')
  const [subdirectory, setSubdirectory] = useState('')
  const [autoRepair, setAutoRepair] = useState(repairAvailable)
  const [publishingEnabled, setPublishingEnabled] = useState(true)
  const [workingBranch, setWorkingBranch] = useState('')
  const [files, setFiles] = useState<UploadFile[]>([])
  const environment = useProjectEnvironment(templates, initialPreset)
  const { unavailableLibrary } = environment
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data: gitConnections } = useGitConnections()
  const connection = gitConnections?.connections.find(
    (entry) => entry.host === repositoryHost(repository),
  )

  function clearRepositoryCredentials() {
    setRepositoryToken('')
    setRepositoryUsername('')
  }

  function selectSource(source: typeof kind) {
    if (source !== kind) clearRepositoryCredentials()
    setKind(source)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (
      kind === 'import' &&
      repositoryUsername.trim() &&
      !repositoryToken.trim()
    ) {
      setError(
        'Enter a repository token for this username, or clear the username for a public import.',
      )
      return
    }
    let configuration
    try {
      if (kind === 'create') configuration = environment.configuration()
    } catch (error) {
      setError(errorText(error))
      return
    }
    setBusy(true)
    setError('')
    const credential = repositoryToken.trim()
    const login = repositoryUsername.trim()
    clearRepositoryCredentials()
    try {
      const project = await post<Project>('/api/projects', {
        name: name.trim() || undefined,
        autoRepair,
        ...(kind !== 'create' && subdirectory.trim()
          ? { subdirectory: subdirectory.trim() }
          : {}),
        ...(kind === 'import'
          ? {
              repository: repository.trim(),
              ...(credential
                ? {
                    repositoryToken: credential,
                    ...(login ? { repositoryUsername: login } : {}),
                  }
                : {}),
              revision: revision.trim() || undefined,
              publishingEnabled,
              ...(publishingEnabled && workingBranch.trim()
                ? { workingBranch: workingBranch.trim() }
                : {}),
            }
          : kind === 'upload'
            ? { files }
            : configuration),
      })
      clearRepositoryCredentials()
      onCreated(project)
    } catch (error) {
      setError(errorText(error))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Open a Lean project"
      subtitle="Paste a project link, upload local files, or start from a library."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} autoComplete="off">
        <div className="segmented-control" aria-label="Project source">
          <button
            type="button"
            aria-pressed={kind === 'import'}
            className={kind === 'import' ? 'selected' : ''}
            onClick={() => selectSource('import')}
            disabled={busy}
          >
            <Icon name="git" />
            Repository
          </button>
          <button
            type="button"
            aria-pressed={kind === 'upload'}
            className={kind === 'upload' ? 'selected' : ''}
            onClick={() => selectSource('upload')}
            disabled={busy}
          >
            <Icon name="folder" />
            Upload
          </button>
          <button
            type="button"
            aria-pressed={kind === 'create'}
            className={kind === 'create' ? 'selected' : ''}
            onClick={() => selectSource('create')}
            disabled={busy}
          >
            <Icon name="plus" />
            New project
          </button>
        </div>
        <label className="field-label" htmlFor="project-name">
          Project name <span>optional</span>
        </label>
        <input
          id="project-name"
          placeholder={
            kind === 'import'
              ? 'Detected from the link'
              : kind === 'upload'
                ? 'Uploaded project'
                : 'My Lean project'
          }
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          maxLength={100}
          autoFocus={kind === 'create'}
        />
        {kind === 'import' ? (
          <>
            <label className="field-label" htmlFor="repository-url">
              Repository or GitHub / GitLab folder link
            </label>
            <input
              id="repository-url"
              autoFocus
              placeholder="https://github.com/owner/project"
              value={repository}
              onChange={(event) => {
                clearRepositoryCredentials()
                setRepository(event.target.value)
              }}
              required
              disabled={busy}
              autoComplete="off"
            />
            <p className="field-help">
              HTTPS repositories on GitHub, GitLab and other Git hosts work.
              GitHub and GitLab folder links work too. Lean versions and
              dependencies are detected automatically. If no Lean setup is
              found, you can choose a new environment after import.
            </p>
            <GitConnectionStatus
              connection={connection}
              onOpenConnections={onOpenConnections}
              disabled={busy}
            />
            <details className="repository-access-options">
              <summary>
                {connection
                  ? 'Use a different token once'
                  : 'Private repository access'}
              </summary>
              <RepositoryCredentialsFields
                idPrefix="import-repository"
                token={repositoryToken}
                username={repositoryUsername}
                onTokenChange={setRepositoryToken}
                onUsernameChange={setRepositoryUsername}
                disabled={busy}
              />
            </details>
            <div className="help-label">
              <label className="setup-repair-choice">
                <input
                  type="checkbox"
                  checked={publishingEnabled}
                  disabled={busy}
                  onChange={(event) =>
                    setPublishingEnabled(event.target.checked)
                  }
                />
                Enable publishing changes back
              </label>
              <HelpTip label="Publishing changes">
                Prepare a working branch, then save, commit and review changes
                before pushing. Import and publishing use your saved Git
                connection, or a token you provide for one operation. After a
                GitHub or GitLab push, open the pull request or merge request
                form to finish submitting your changes.
              </HelpTip>
            </div>
            {publishingEnabled && (
              <>
                <label className="field-label" htmlFor="import-working-branch">
                  Working branch <span>optional</span>
                </label>
                <input
                  id="import-working-branch"
                  value={workingBranch}
                  onChange={(event) => setWorkingBranch(event.target.value)}
                  placeholder="Generate a new leanflow/… branch"
                  disabled={busy}
                  autoComplete="off"
                />
                <p className="field-help">
                  Leave blank to create a unique branch at the imported
                  revision. Nothing is pushed during import. You can publish to
                  this repository or an existing fork where you have write
                  access. If the name conflicts, existing branches are kept and
                  a unique working branch is chosen.
                </p>
              </>
            )}
          </>
        ) : kind === 'upload' ? (
          <UploadFiles
            files={files}
            disabled={busy}
            onChange={(values, folder) => {
              setFiles(values)
              if (folder && !name) setName(folder)
            }}
          />
        ) : (
          <>
            <ProjectEnvironmentFields
              templates={templates}
              environment={environment}
              disabled={busy}
            />
          </>
        )}
        {kind !== 'create' && (
          <details className="import-options">
            <summary>More options</summary>
            <label className="field-label" htmlFor="project-subdirectory">
              Lean project subdirectory <span>optional</span>
            </label>
            <input
              id="project-subdirectory"
              value={subdirectory}
              placeholder="Detected automatically"
              onChange={(event) => setSubdirectory(event.target.value)}
              disabled={busy}
            />
            {kind === 'import' && (
              <>
                <label className="field-label" htmlFor="revision">
                  Branch, tag, or commit <span>optional</span>
                </label>
                <input
                  id="revision"
                  value={revision}
                  placeholder="From the link or default branch"
                  onChange={(event) => setRevision(event.target.value)}
                  disabled={busy}
                />
              </>
            )}
          </details>
        )}
        {kind !== 'create' && (
          <label className="setup-repair-choice">
            <input
              type="checkbox"
              checked={autoRepair}
              onChange={(event) => setAutoRepair(event.target.checked)}
              disabled={busy || !repairAvailable}
            />
            <span>
              Let Lemex repair setup if needed.
              <br />
              <span className="field-help">
                {repairAvailable
                  ? "We'll show when it starts, keep the original configuration, and check the result."
                  : 'Lemex setup repair is unavailable on this server. Automatic Lean and library setup still runs. You can edit setup files and retry if needed.'}
              </span>
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <footer className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={
              busy ||
              (kind === 'import'
                ? !repository.trim()
                : kind === 'upload'
                  ? !files.length
                  : !templates.length || unavailableLibrary)
            }
          >
            {busy ? (
              <>
                <span className="spinner" />
                Creating project…
              </>
            ) : (
              <>
                {kind === 'import'
                  ? 'Import project'
                  : kind === 'upload'
                    ? 'Open uploaded project'
                    : 'Create project'}
                <Icon name="arrow" size={16} />
              </>
            )}
          </button>
        </footer>
      </form>
    </Dialog>
  )
}
