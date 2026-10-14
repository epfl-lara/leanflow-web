import type { Project } from './api'
import { useEffect, useState } from 'react'

const stages = {
  'waiting-for-repair': [
    'Waiting for Lemex',
    'Setup repair is queued for an available assistant slot. You can keep working in another project.',
  ],
  'reading-project': [
    'Reading the project',
    'Finding the Lean environment and checking the project configuration.',
  ],
  'preparing-lean': [
    'Preparing Lean',
    'Installing or reusing the Lean version pinned by this project.',
  ],
  'preparing-dependencies': [
    'Preparing libraries',
    'Fetching pinned dependencies, reusing compiled files and building missing modules. Large libraries can take a while the first time.',
  ],
  'building-project': [
    'Building the project',
    'Preparing project modules so files can import each other in the editor.',
  ],
  'checking-environment': [
    'Testing the environment',
    'Checking that Lean and the project libraries are ready for the editor.',
  ],
  'repairing-setup': [
    'Lemex is repairing setup',
    'Automatic setup encountered a problem. Lemex is diagnosing it and checking a configuration repair.',
  ],
  'validating-repair': [
    'Testing the setup repair',
    'Checking the proposed configuration with Lean before retrying project setup.',
  ],
} satisfies Record<
  NonNullable<Project['setupPhase']>,
  readonly [string, string]
>

export function ProjectSetupProgress({ project }: { project: Project }) {
  const [now, setNow] = useState(Date.now)
  const started = project.setupRepair?.startedAt || project.setupStartedAt
  useEffect(() => {
    if (!started) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [started])
  const seconds = started
    ? Math.max(0, Math.floor((now - Date.parse(started)) / 1000))
    : null
  const [title, detail] =
    stages[
      project.setupPhase ||
        (project.setupRepair?.status === 'running'
          ? 'repairing-setup'
          : 'reading-project')
    ]
  return (
    <div className="setup-repair-notice" role="status" aria-live="polite">
      <strong>
        <span className="spinner" aria-hidden="true" /> {title}
      </strong>
      <p>{detail}</p>
      {project.setupRepair?.activity && <p>{project.setupRepair.activity}</p>}
      {seconds !== null && Number.isFinite(seconds) && (
        <p>
          Elapsed: {Math.floor(seconds / 60)}:
          {String(seconds % 60).padStart(2, '0')}
        </p>
      )}
      {project.toolchain && (
        <p>
          Lean version: {project.toolchain.replace('leanprover/lean4:', '')}
        </p>
      )}
    </div>
  )
}
