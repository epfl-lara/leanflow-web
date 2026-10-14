import type { Project } from './api'
import { ProjectSetupProgress } from './ProjectSetupProgress'

export function ProjectSetupDetails({ project }: { project: Project }) {
  return (
    <>
      {project.status === 'preparing' && (
        <ProjectSetupProgress project={project} />
      )}
      {project.status === 'ready' &&
        !project.needsPreparation &&
        project.toolchain && (
          <div className="setup-repair-notice">
            <strong>Setup summary</strong>
            <p>
              Ready for editing with Lean{' '}
              {project.toolchain.replace('leanprover/lean4:', '')}.
            </p>
            {project.setupBuildStatus === 'passed' && (
              <p>Project build passed.</p>
            )}
            {project.setupBuildStatus === 'reused' && (
              <p>Reused the verified library environment.</p>
            )}
            {project.setupBuildStatus === 'warnings' && (
              <p>
                Some project targets need attention. See the build messages
                below.
              </p>
            )}
            {project.subdirectory && (
              <p>Project folder: {project.subdirectory}</p>
            )}
            {project.sourceRevision && (
              <p>
                Source revision: <code>{project.sourceRevision}</code>
              </p>
            )}
          </div>
        )}
      {project.publishingWarning && (
        <div className="setup-repair-notice" role="status">
          <strong>Working branch adjusted</strong>
          <p>{project.publishingWarning}</p>
        </div>
      )}
      {project.dependencyWarning && (
        <div className="setup-repair-notice" role="status">
          <strong>Dependencies need preparation</strong>
          <p>{project.dependencyWarning}</p>
        </div>
      )}
      {project.status === 'ready' &&
        project.buildWarning &&
        !project.dependencyWarning && (
          <div className="setup-repair-notice" role="status">
            <strong>Project opened with build errors</strong>
            <p>{project.buildWarning}</p>
            <p>
              Open the affected files to inspect Lean's messages, then use Check
              Project after fixing them.
            </p>
          </div>
        )}
      {project.setupRepair && project.status !== 'preparing' && (
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
