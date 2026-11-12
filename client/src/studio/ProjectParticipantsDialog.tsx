import { useEffect, useState } from 'react'
import { api, errorText, type Project, type ProjectParticipants } from './api'
import { Dialog } from './Dialog'

export function ProjectParticipantsDialog({
  project,
  currentUserId,
  onClose,
}: {
  project: Project
  currentUserId: string
  onClose: () => void
}) {
  const [participants, setParticipants] = useState<ProjectParticipants | null>(
    null,
  )
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void api<ProjectParticipants>(
      `/api/projects/${encodeURIComponent(project.id)}/participants`,
      {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      },
    )
      .then(setParticipants)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error))
      })
    return () => controller.abort()
  }, [project.id, attempt])

  return (
    <Dialog
      title="Project participants"
      subtitle={project.name}
      onClose={onClose}
    >
      <div className="project-sharing">
        <p className="field-help">Project admins manage access.</p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {!participants ? (
          <div>
            <output>
              {error
                ? 'Participants could not load. Try again.'
                : 'Loading project participants…'}
            </output>
            {error && (
              <button
                type="button"
                className="button small secondary"
                onClick={() => {
                  setError('')
                  setAttempt((value) => value + 1)
                }}
              >
                Retry participants
              </button>
            )}
          </div>
        ) : (
          <section aria-label="People with access">
            <h3>People with access</h3>
            <div className="sharing-people">
              {participants.members.map((member) => (
                <div className="sharing-person" key={member.userId}>
                  <span className="sharing-person-name">
                    {member.name || member.userId}
                    {member.userId === currentUserId && <small>You</small>}
                  </span>
                  <span className="tag">
                    {member.role === 'admin'
                      ? 'Admin'
                      : member.role === 'editor'
                        ? 'Editor'
                        : 'Viewer'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <footer className="dialog-actions">
        <button className="button secondary" type="button" onClick={onClose}>
          Done
        </button>
      </footer>
    </Dialog>
  )
}
