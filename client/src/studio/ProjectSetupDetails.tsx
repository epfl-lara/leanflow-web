import type { Project } from './api'
import { ProjectSetupProgress } from './ProjectSetupProgress'

const buildResults = {
  passed: ['success', 'Build passed'],
  reused: ['', 'Libraries reused'],
  warnings: ['', 'Build warnings'],
} satisfies Record<
  NonNullable<Project['setupBuildStatus']>,
  readonly [string, string]
>

function readyLeanVersion(project: Project) {
  return project.status === 'ready' && !project.needsPreparation
    ? project.toolchain?.replace('leanprover/lean4:', '')
    : undefined
}

export function ProjectSetupPanel({ project }: { project: Project }) {
  const needsAttention = Boolean(
    project.status === 'error' ||
    project.needsPreparation ||
    project.dependencyWarning ||
    project.buildWarning ||
    project.publishingWarning,
  )
  const lean = readyLeanVersion(project)
  const build =
    lean && project.setupBuildStatus && buildResults[project.setupBuildStatus]
  return (
    <details className="setup-editor-details" open={needsAttention}>
      <summary>
        <strong>Project setup</strong>
        <span className={`tag setup-status ${build ? build[0] : ''}`}>
          {build
            ? build[1]
            : project.status === 'preparing'
              ? 'Preparing'
              : needsAttention
                ? 'Needs attention'
                : 'Ready'}
        </span>
        {lean && (
          <span className="setup-digest">
            Lean {lean}
            {project.sourceRevision && (
              <>
                {' · '}
                <code title={project.sourceRevision}>
                  {project.sourceRevision.slice(0, 7)}
                </code>
              </>
            )}
          </span>
        )}
      </summary>
      <div className="setup-editor-content">
        <ProjectSetupDetails project={project} />
      </div>
    </details>
  )
}

export function ProjectSetupDetails({ project }: { project: Project }) {
  const lean = readyLeanVersion(project)
  return (
    <>
      {project.status === 'preparing' && (
        <ProjectSetupProgress project={project} />
      )}
      {lean &&
        (project.repository ||
          project.sourceRevision ||
          project.subdirectory) && (
          <dl className="setup-facts">
            {project.repository && (
              <>
                <dt>Repository</dt>
                <dd>{project.repository}</dd>
              </>
            )}
            {project.subdirectory && (
              <>
                <dt>Folder</dt>
                <dd>{project.subdirectory}</dd>
              </>
            )}
            {project.sourceRevision && (
              <>
                <dt>Revision</dt>
                <dd>
                  <code>{project.sourceRevision}</code>
                </dd>
              </>
            )}
          </dl>
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
            <strong>Project build needs attention</strong>
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
        <details className="setup-output" open={project.status === 'error'}>
          <summary>Setup output</summary>
          <pre className="setup-log">{project.log}</pre>
        </details>
      )}
      {project.repository && !lean && (
        <p className="field-help">{project.repository}</p>
      )}
    </>
  )
}
