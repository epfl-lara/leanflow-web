import { useRef, useState } from 'react'
import { Icon } from './Icons'
import { errorText, type PlaygroundPreparationState } from './api'
import { readSourceFiles, type UploadFile } from './UploadFiles'

export function SingleFileActions({
  available,
  busy,
  primary = false,
  busySource,
  preparationState,
  onRetry,
  onCreate,
  onError,
}: {
  available: boolean
  busy: boolean
  primary?: boolean
  busySource?: 'blank' | 'upload'
  preparationState?: PlaygroundPreparationState
  onRetry?: () => void
  onCreate: (file?: UploadFile) => void
  onError: (message: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  async function upload(file: File) {
    setReading(true)
    try {
      if (!file.name.endsWith('.lean'))
        throw new Error('Choose one .lean file.')
      const result = await readSourceFiles([{ file, path: file.name }])
      onCreate(result.files[0])
    } catch (error) {
      onError(errorText(error))
    } finally {
      setReading(false)
    }
  }
  return (
    <div className="single-file-actions">
      <button
        className={`button ${primary ? 'primary' : 'secondary small'}`}
        title="New Mathlib playground"
        disabled={!available || busy || reading}
        onClick={() => onCreate()}
      >
        {busy && busySource !== 'upload' ? (
          <span className="spinner" />
        ) : (
          <Icon name="file" size={16} />
        )}
        {busy && busySource !== 'upload'
          ? 'Opening…'
          : primary
            ? 'Mathlib Playground'
            : 'New playground'}
      </button>
      <button
        className={`button subtle ${primary ? '' : 'small'}`}
        disabled={!available || busy || reading}
        onClick={() => input.current?.click()}
      >
        {reading
          ? 'Reading…'
          : busy && busySource === 'upload'
            ? 'Opening…'
            : 'Open .lean file'}
      </button>
      <input
        ref={input}
        type="file"
        accept=".lean"
        hidden
        aria-label="Upload a single Lean file"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void upload(file)
          event.target.value = ''
        }}
      />
      {!available && (
        <p className="field-help">
          {preparationState === 'verifying'
            ? 'Checking the prepared Mathlib environment…'
            : preparationState === 'failed'
              ? 'Mathlib preparation failed. You can retry the check.'
              : 'Mathlib needs to be prepared by the server administrator.'}
          {preparationState === 'failed' && onRetry && (
            <button
              type="button"
              className="button small subtle"
              onClick={onRetry}
            >
              Retry Mathlib preparation
            </button>
          )}
        </p>
      )}
    </div>
  )
}
