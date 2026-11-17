import { useEffect, useState } from 'react'
import { Icon } from './Icons'

export function CheckControls({
  disabled,
  singleFile,
  starting,
  activeJob,
  stopping,
  onCheck,
  onStop,
}: {
  disabled: boolean
  singleFile: boolean
  starting: boolean
  activeJob: { createdAt: string; status: string } | null
  stopping: boolean
  onCheck: (scope: 'file' | 'project') => void
  onStop: () => void
}) {
  const [now, setNow] = useState(Date.now)
  const createdAt = activeJob?.createdAt
  useEffect(() => {
    if (!createdAt) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [createdAt])
  const elapsed = activeJob
    ? Math.max(0, (now - Date.parse(activeJob.createdAt)) / 60_000)
    : 0

  return (
    <>
      {!singleFile && !starting && !activeJob && (
        <button
          className="button small subtle"
          onClick={() => onCheck('file')}
          disabled={disabled}
          title="Save your changes and compile the selected Lean file"
        >
          Check File
        </button>
      )}
      <button
        className="button small subtle lean-check-button"
        onClick={() => onCheck(singleFile ? 'file' : 'project')}
        disabled={disabled || starting || !!activeJob}
        title={
          singleFile
            ? 'Save your changes and compile the selected Lean file'
            : 'Check the project’s default targets and the selected Lean file'
        }
      >
        <Icon name="check" size={14} />
        {activeJob
          ? `Checking… ${elapsed.toFixed(2)} min`
          : starting
            ? 'Starting check…'
            : singleFile
              ? 'Check File'
              : 'Check Project'}
      </button>
      {activeJob && (
        <button
          className="button small subtle"
          onClick={onStop}
          disabled={stopping || activeJob.status === 'stopping'}
        >
          <Icon name="stop" size={14} />
          {stopping || activeJob.status === 'stopping'
            ? 'Stopping…'
            : 'Stop check'}
        </button>
      )}
    </>
  )
}
