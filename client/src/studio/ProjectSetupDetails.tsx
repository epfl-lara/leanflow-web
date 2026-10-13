import type { Project } from './api'

export function ProjectSetupDetails({ project }: { project: Project }) {
  return (
    <>
      {project.setupRepair && (
        <div className="setup-repair-notice" role="status">
          <strong>
            {project.setupRepair.status === 'running'
              ? 'Lemex is repairing setup'
              : project.setupRepair.status === 'completed'
                ? 'Setup repaired and tested'
                : 'Setup repair needs attention'}
          </strong>
          <p>{project.setupRepair.message}</p>
          {!!project.setupRepair.changes?.length && (
            <p>Updated: {project.setupRepair.changes.join(', ')}</p>
          )}
        </div>
      )}
      {project.log && (
        <details open={project.status === 'error'}>
          <summary>Setup output</summary>
          <pre className="setup-log">{project.log}</pre>
        </details>
      )}
      {project.repository && <p className="field-help">{project.repository}</p>}
    </>
  )
}
