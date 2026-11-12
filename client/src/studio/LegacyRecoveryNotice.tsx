import { useState } from 'react'
import { type Project } from './api'
import { LegacyFileRecovery } from './LegacyFileRecovery'

export function LegacyRecoveryNotice({
  project,
  onRecovered,
}: {
  project: Project
  onRecovered: (project: Project) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="legacy-recovery-notice"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Review older file updates</summary>
      {open && (
        <>
          <p>
            The older history scan was deferred. You can continue working. Open
            this review to check for an interrupted update; project files are
            never restored automatically.
          </p>
          <LegacyFileRecovery project={project} onRecovered={onRecovered} />
        </>
      )}
    </details>
  )
}
