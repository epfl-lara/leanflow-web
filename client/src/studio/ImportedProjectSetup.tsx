import { useState, type FormEvent } from 'react'
import {
  api,
  ApiError,
  errorText,
  post,
  type Preset,
  type Project,
} from './api'
import {
  ProjectEnvironmentFields,
  useProjectEnvironment,
} from './ProjectEnvironmentFields'

export function ImportedProjectSetup({
  project,
  templates,
  onConfigured,
}: {
  project: Project
  templates: Preset[]
  onConfigured: (project: Project) => void
}) {
  const environment = useProjectEnvironment(templates)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')
    try {
      const configuration = environment.configuration()
      setBusy(true)
      onConfigured(
        await post<Project>(
          `/api/projects/${encodeURIComponent(project.id)}/environment`,
          configuration,
        ),
      )
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const current = await api<Project>(
            `/api/projects/${encodeURIComponent(project.id)}`,
          )
          if (current.status !== 'needs-setup') {
            onConfigured(current)
            return
          }
        } catch {
          /* Keep the original actionable error. */
        }
      }
      setError(errorText(error))
      setBusy(false)
    }
  }
  return (
    <section className="import-environment-setup">
      <h1>Set up Lean for {project.name}</h1>
      <p>
        Your files have been imported. No Lean configuration was found. Choose
        the environment for your formalization; your existing files will be
        kept.
      </p>
      {project.repository && <p className="field-help">{project.repository}</p>}
      <p className="field-help">
        Setup files will be added in{' '}
        {project.subdirectory
          ? `the ${project.subdirectory} folder`
          : 'the project root'}
        .
      </p>
      {project.importWarning && (
        <p role="status" className="field-help">
          {project.importWarning}
        </p>
      )}
      <form onSubmit={submit}>
        <ProjectEnvironmentFields
          templates={templates}
          environment={environment}
          disabled={busy}
          idPrefix="configure-"
          afterImport
        />
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="button primary"
          disabled={busy || !templates.length || environment.unavailableLibrary}
        >
          {busy ? 'Preparing environment…' : 'Prepare environment'}
        </button>
      </form>
    </section>
  )
}
