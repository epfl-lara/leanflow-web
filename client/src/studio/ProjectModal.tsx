import { useState, type FormEvent } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { errorText, post, type Preset, type Project } from './api'

export function ProjectModal({
  templates,
  onClose,
  onCreated,
}: {
  templates: Preset[]
  onClose: () => void
  onCreated: (project: Project) => void
}) {
  const [kind, setKind] = useState<'create' | 'import'>('import')
  const [name, setName] = useState('')
  const [repository, setRepository] = useState('')
  const [revision, setRevision] = useState('')
  const [preset, setPreset] = useState(templates[0]?.id || 'mathlib')
  const [leanVersion, setLeanVersion] = useState(
    templates
      .find((template) => template.id === 'lean')
      ?.toolchain?.replace('leanprover/lean4:', '') || '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = templates.find((template) => template.id === preset)

  async function submit(event: FormEvent) {
    event.preventDefault()
    let toolchain: string | undefined
    if (kind === 'create' && preset === 'lean') {
      let version = leanVersion.trim().replace(/^leanprover\/lean4:/, '')
      if (!version)
        version = selected?.toolchain?.replace('leanprover/lean4:', '') || ''
      if (version.startsWith('4.')) version = `v${version}`
      if (!/^v4\.\d+\.\d+(?:-rc\d+)?$/.test(version)) {
        setError('Use an exact Lean 4 release, such as v4.34.1 or v4.35.0-rc4.')
        return
      }
      toolchain = `leanprover/lean4:${version}`
    }
    setBusy(true)
    setError('')
    try {
      const project = await post<Project>('/api/projects', {
        name: name.trim() || undefined,
        ...(kind === 'import'
          ? {
              repository: repository.trim(),
              revision: revision.trim() || undefined,
            }
          : { preset, ...(toolchain ? { toolchain } : {}) }),
      })
      onCreated(project)
    } catch (error) {
      setError(errorText(error))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Open a Lean project"
      subtitle="Import your repository or start with a prepared library."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <div className="segmented-control" aria-label="Project source">
          <button
            type="button"
            aria-pressed={kind === 'import'}
            className={kind === 'import' ? 'selected' : ''}
            onClick={() => setKind('import')}
            disabled={busy}
          >
            <Icon name="git" />
            Import repository
          </button>
          <button
            type="button"
            aria-pressed={kind === 'create'}
            className={kind === 'create' ? 'selected' : ''}
            onClick={() => setKind('create')}
            disabled={busy}
          >
            <Icon name="plus" />
            New project
          </button>
        </div>
        {kind === 'import' ? (
          <>
            <label className="field-label" htmlFor="repository-url">
              Git repository URL
            </label>
            <input
              id="repository-url"
              autoFocus
              placeholder="https://github.com/owner/project"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              required
              disabled={busy}
              autoComplete="off"
            />
            <p className="field-help">
              The project's Lean version and Lake dependencies are detected
              automatically.
            </p>
            <label className="field-label" htmlFor="revision">
              Branch, tag, or commit <span>optional</span>
            </label>
            <input
              id="revision"
              placeholder="Default branch"
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="library-preset">
              Library preset
            </label>
            <div className="preset-list" id="library-preset">
              {templates.map((template) => (
                <label
                  key={template.id}
                  className={`preset-option ${preset === template.id ? 'chosen' : ''}`}
                >
                  <input
                    type="radio"
                    name="preset"
                    value={template.id}
                    checked={preset === template.id}
                    onChange={() => setPreset(template.id)}
                    disabled={busy}
                  />
                  <div>
                    <strong>{template.name}</strong>
                    <p>{template.description}</p>
                    {template.toolchain && (
                      <code>
                        {template.toolchain.replace('leanprover/lean4:', '')}
                      </code>
                    )}
                  </div>
                  {template.ready && (
                    <span className="tag success">Prepared</span>
                  )}
                </label>
              ))}
            </div>
            {templates.length === 0 && (
              <p className="error-message">
                No presets are available. Import an existing repository instead.
              </p>
            )}
            {selected && (
              <p className="field-help">
                Dependencies are installed in a persistent project workspace.
              </p>
            )}
            {preset === 'lean' && (
              <>
                <label className="field-label" htmlFor="lean-version">
                  Lean version
                </label>
                <input
                  id="lean-version"
                  value={leanVersion}
                  placeholder={
                    selected?.toolchain?.replace('leanprover/lean4:', '') ||
                    'v4.34.1'
                  }
                  onChange={(event) => setLeanVersion(event.target.value)}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="lean-version-help"
                />
                <p id="lean-version-help" className="field-help">
                  Use an exact release, such as v4.34.1. The server installs and
                  caches it when needed. Library presets use their tested Lean
                  versions.
                </p>
              </>
            )}
          </>
        )}
        <label className="field-label" htmlFor="project-name">
          Project name <span>optional</span>
        </label>
        <input
          id="project-name"
          placeholder={
            kind === 'import' ? 'Taken from the repository' : 'My Lean project'
          }
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          maxLength={100}
        />
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
              (kind === 'import' ? !repository.trim() : !templates.length)
            }
          >
            {busy ? (
              <>
                <span className="spinner" />
                Creating project…
              </>
            ) : (
              <>
                {kind === 'import' ? 'Import project' : 'Create project'}
                <Icon name="arrow" size={16} />
              </>
            )}
          </button>
        </footer>
      </form>
    </Dialog>
  )
}
