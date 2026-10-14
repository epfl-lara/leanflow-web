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
  onCheck: () => void
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
      <button
        className="button small subtle lean-check-button"
        onClick={onCheck}
        disabled={disabled || starting || !!activeJob}
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
