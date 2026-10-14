import { useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { errorText, post } from './api'
import './upload.css'
import {
  sourceFileByteLimit,
  MAX_SOURCE_UPLOAD_BYTES,
} from '../../../shared/source-limits.mjs'
import {
  isPdfFile,
  MAX_PDF_FILE_BYTES,
} from '../../../shared/file-previews.mjs'

export interface UploadFile {
  path: string
  content: string
  encoding?: 'base64'
}
const excluded =
  /^(?:\.git|\.lake|node_modules|\.lemex|\.codex|\.ssh|\.aws|\.azure|\.config|\.netrc|\.npmrc|\.pypirc|__MACOSX|\.DS_Store|\.env(?:\..*)?|credentials(?:\.json)?|auth\.json|settings\.local\.json|.*\.(?:pem|key|p12|pfx))$/i

export async function readSourceFiles(files: { file: File; path: string }[]) {
  const usable = files.filter(
    (item) => !item.path.split('/').some((part) => excluded.test(part)),
  )
  if (!usable.length)
    throw new Error('Choose Lean source files or a project folder.')
  if (usable.length > 5000)
    throw new Error('Choose at most 5,000 source files.')
  if (
    usable.reduce((sum, item) => sum + item.file.size, 0) >
    MAX_SOURCE_UPLOAD_BYTES
  )
    throw new Error(
      'Source files must total at most 32 MiB. Build caches are excluded automatically.',
    )
  const first = usable[0].path.split('/')[0]
  const stripFolder = usable.every((item) => item.path.startsWith(first + '/'))
  const result: UploadFile[] = []
  for (const item of usable) {
    const pdf = isPdfFile(item.path)
    const limit = pdf ? MAX_PDF_FILE_BYTES : sourceFileByteLimit(item.path)
    if (item.file.size > limit)
      throw new Error(
        `${item.path} is larger than ${limit / (1024 * 1024)} MiB. Choose a smaller file.`,
      )
    const bytes = new Uint8Array(await item.file.arrayBuffer())
    const path = stripFolder ? item.path.slice(first.length + 1) : item.path
    if (pdf) {
      const chunks: string[] = []
      for (let offset = 0; offset < bytes.length; offset += 32768)
        chunks.push(
          String.fromCharCode(...bytes.subarray(offset, offset + 32768)),
        )
      result.push({ path, content: btoa(chunks.join('')), encoding: 'base64' })
      continue
    }
    let content: string
    try {
      if (bytes.includes(0)) throw new Error()
      content = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes)
    } catch {
      throw new Error(
        `${item.path} is not a UTF-8 source file or a PDF. Choose supported files.`,
      )
    }
    result.push({
      path,
      content,
    })
  }
  return {
    files: result,
    skipped: files.length - usable.length,
    folder: stripFolder ? first : '',
  }
}

async function droppedFiles(entries: FileSystemEntry[], fallback: File[]) {
  if (!entries.length)
    return fallback.map((file) => ({ file, path: file.name }))
  const result: { file: File; path: string }[] = []
  async function visit(entry: FileSystemEntry, prefix = '', depth = 0) {
    if (depth > 32 || result.length >= 5000)
      throw new Error('The folder is too large or deeply nested.')
    if (excluded.test(entry.name)) return
    const name = prefix + entry.name
    if (entry.isFile)
      result.push({
        file: await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        ),
        path: name,
      })
    else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const children = await new Promise<FileSystemEntry[]>(
          (resolve, reject) => reader.readEntries(resolve, reject),
        )
        if (!children.length) break
        for (const child of children) await visit(child, name + '/', depth + 1)
      }
    }
  }
  for (const entry of entries) await visit(entry)
  return result
}

export function UploadFiles({
  files,
  onChange,
  disabled = false,
}: {
  files: UploadFile[]
  onChange: (files: UploadFile[], folder?: string) => void
  disabled?: boolean
}) {
  const filesInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false),
    [error, setError] = useState(''),
    [skipped, setSkipped] = useState(0)
  async function choose(
    input:
      | Promise<{ file: File; path: string }[]>
      | { file: File; path: string }[],
  ) {
    setReading(true)
    setError('')
    try {
      const value = await readSourceFiles(await input)
      onChange(value.files, value.folder)
      setSkipped(value.skipped)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setReading(false)
    }
  }
  return (
    <div className="upload-files">
      <div
        className="upload-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          if (disabled || reading) return
          const entries = [...event.dataTransfer.items]
            .map((item) => item.webkitGetAsEntry?.())
            .filter((entry): entry is FileSystemEntry => !!entry)
          void choose(droppedFiles(entries, [...event.dataTransfer.files]))
        }}
      >
        <strong>
          {reading ? 'Reading files…' : 'Drop files or a project folder here'}
        </strong>
        <div className="upload-choices">
          <button
            type="button"
            className="button secondary"
            disabled={disabled || reading}
            onClick={() => filesInput.current?.click()}
          >
            Choose files
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={disabled || reading}
            onClick={() => folderInput.current?.click()}
          >
            Choose folder
          </button>
        </div>
        <input
          ref={filesInput}
          type="file"
          multiple
          hidden
          aria-label="Upload source files"
          onChange={(event) => {
            void choose(
              [...(event.target.files || [])].map((file) => ({
                file,
                path: file.name,
              })),
            )
            event.target.value = ''
          }}
        />
        <input
          ref={(element) => {
            folderInput.current = element
            element?.setAttribute('webkitdirectory', '')
          }}
          type="file"
          multiple
          hidden
          aria-label="Upload project folder"
          onChange={(event) => {
            void choose(
              [...(event.target.files || [])].map((file) => ({
                file,
                path: file.webkitRelativePath || file.name,
              })),
            )
            event.target.value = ''
          }}
        />
        <p>
          UTF-8 sources up to 8 MiB per file, PDFs up to 16 MiB, and 32 MiB
          total. Git metadata, build caches, and private settings stay on your
          computer.
        </p>
      </div>
      {!!files.length && (
        <div className="upload-preview">
          <strong>
            {files.length} {files.length === 1 ? 'file' : 'files'} ready
          </strong>
          <ul>
            {files.slice(0, 8).map((file) => (
              <li key={file.path}>{file.path}</li>
            ))}
          </ul>
          {files.length > 8 && <p>and {files.length - 8} more</p>}
          {skipped > 0 && <p>{skipped} cache or private files excluded.</p>}
          <button
            type="button"
            className="button small subtle"
            disabled={disabled}
            onClick={() => onChange([])}
          >
            Clear selection
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </div>
  )
}

export function UploadModal({
  projectId,
  onClose,
  onUploaded,
}: {
  projectId: string
  onClose: () => void
  onUploaded: () => Promise<void>
}) {
  const [files, setFiles] = useState<UploadFile[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <Dialog
      title="Add local files"
      subtitle="Choose files or a folder. Existing project files are kept."
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          try {
            await post(
              `/api/projects/${encodeURIComponent(projectId)}/upload`,
              { files },
            )
            await onUploaded()
            onClose()
          } catch (error) {
            setError(errorText(error))
            setBusy(false)
          }
        }}
      >
        <UploadFiles files={files} onChange={setFiles} disabled={busy} />
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy || !files.length}>
            {busy ? 'Uploading…' : 'Add files'}
          </button>
        </footer>
      </form>
    </Dialog>
  )
}
