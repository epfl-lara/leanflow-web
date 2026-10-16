/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to focus and scroll compiler output. */
import { useEffect, useId, useRef, useState } from 'react'
import type { OpenFile } from './api'
import { PdfFileViewer } from './PdfFileViewer'
import { defaultTexRoot, texPdfIsStale, texInputInRoot } from './texBuilds'
import { useTexBuild } from './useTexBuild'
import './tex.css'

export function TexPanel({
  projectId,
  files,
  currentPath,
  visible,
  buffers,
  saving,
  saveVersion,
  savedPaths,
  save,
  onOpenFile,
}: {
  projectId: string
  files: string[]
  currentPath?: string
  visible: boolean
  buffers: ReadonlyMap<string, OpenFile>
  saving: boolean
  saveVersion: number
  savedPaths: readonly string[]
  save: () => Promise<void>
  onOpenFile: (path: string, line?: number) => void
}) {
  const [selectedRoot, setSelectedRoot] = useState(() => {
    try {
      const saved = localStorage.getItem(`lemex-tex-root-${projectId}`)
      if (saved && files.includes(saved)) return saved
    } catch {
      /* Root selection still works without storage. */
    }
    return defaultTexRoot(files, currentPath)
  })
  const rootFile = files.includes(selectedRoot)
    ? selectedRoot
    : defaultTexRoot(files, currentPath)
  const dirty = [...buffers.values()].some(
    (file) =>
      !file.readOnly &&
      file.content !== file.savedContent &&
      texInputInRoot(rootFile, file.path),
  )
  const [inputSaveVersion, setInputSaveVersion] = useState(0)
  const observedSave = useRef(saveVersion)
  useEffect(() => {
    if (observedSave.current === saveVersion) return
    observedSave.current = saveVersion
    if (savedPaths.some((path) => texInputInRoot(rootFile, path)))
      setInputSaveVersion((version) => version + 1)
  }, [rootFile, saveVersion, savedPaths])
  const tex = useTexBuild({
    projectId,
    rootFile,
    visible,
    dirty,
    saveVersion: inputSaveVersion,
    save,
  })
  const optionsId = useId()
  const [showOptions, setShowOptions] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const build = tex.activeBuild || tex.status?.build
  const successful = tex.status?.lastSuccessful
  const stale = texPdfIsStale(tex.status, rootFile, dirty, tex.savedSinceBuild)
  const errors = build?.diagnostics?.filter(
    (diagnostic) => diagnostic.severity === 'error',
  )
  const warnings = build?.diagnostics?.filter(
    (diagnostic) => diagnostic.severity !== 'error',
  )
  const diagnostics = (items: NonNullable<typeof errors>) => (
    <ul className="tex-diagnostics" aria-label="LaTeX diagnostics">
      {items.slice(0, 100).map((diagnostic, index) => (
        <li
          key={`${index}:${diagnostic.path}:${diagnostic.line}`}
          className={`tex-diagnostic-${diagnostic.severity}`}
        >
          {diagnostic.path ? (
            <button
              onClick={() =>
                diagnostic.path && onOpenFile(diagnostic.path, diagnostic.line)
              }
            >
              {diagnostic.path}
              {diagnostic.line ? `:${diagnostic.line}` : ''} ·{' '}
              {diagnostic.message}
            </button>
          ) : (
            <span>{diagnostic.message}</span>
          )}
        </li>
      ))}
    </ul>
  )
  useEffect(() => {
    if (!selectedRoot && rootFile) setSelectedRoot(rootFile)
    if (rootFile) {
      try {
        localStorage.setItem(`lemex-tex-root-${projectId}`, rootFile)
      } catch {
        /* Root selection still works without storage. */
      }
    }
  }, [selectedRoot, rootFile, projectId])

  return (
    <section
      className="tex-panel"
      aria-label="LaTeX PDF workspace"
      hidden={!visible}
    >
      <div className="tex-toolbar">
        <button
          className="button small primary"
          disabled={
            !rootFile ||
            !tex.status?.available ||
            tex.active ||
            tex.starting ||
            tex.stopping
          }
          onClick={() => void tex.start(true)}
        >
          {tex.starting ? 'Starting…' : 'Build PDF'}
        </button>
        {tex.active && (
          <button
            className="button small secondary"
            disabled={tex.stopping}
            onClick={() => void tex.stop()}
          >
            {tex.stopping ? 'Stopping…' : 'Stop build'}
          </button>
        )}
        <output className="tex-build-status" title={rootFile || undefined}>
          {tex.active ? (
            <span>
              <span className="spinner" />{' '}
              {tex.activeBuild?.cleanupFailed
                ? 'Compiler cleanup needs retry'
                : tex.activeBuild?.origin === 'agent'
                  ? 'Lemex is compiling…'
                  : build?.status === 'queued'
                    ? 'Build queued'
                    : 'Building PDF'}
              {tex.queued ? ' · New save queued' : ''}
            </span>
          ) : build ? (
            <span>
              {build.status === 'completed'
                ? 'PDF built'
                : build.status === 'cancelled'
                  ? 'Build stopped'
                  : build.status === 'failed'
                    ? 'Build failed'
                    : build.status}
            </span>
          ) : (
            <span>
              {rootFile
                ? 'Ready to build'
                : 'Choose a root document in Options'}
            </span>
          )}
          {successful?.pdf && stale && (
            <span className="tex-pdf-stale">PDF may be out of date</span>
          )}
        </output>
        <button
          className="button small secondary tex-options-toggle"
          aria-label="PDF options"
          aria-expanded={showOptions}
          aria-controls={optionsId}
          title="Root document, rebuild on save, build log, and PDF actions"
          onClick={() => setShowOptions((value) => !value)}
        >
          Options{warnings?.length ? ` (${warnings.length})` : ''}{' '}
          <span aria-hidden="true">{showOptions ? '▴' : '▾'}</span>
        </button>
      </div>
      <div id={optionsId} className="tex-options" hidden={!showOptions}>
        <div className="tex-build-options">
          <label className="tex-root-label">
            Root document
            <select
              aria-label="LaTeX root document"
              value={rootFile}
              onChange={(event) => setSelectedRoot(event.target.value)}
              disabled={saving || tex.active || tex.starting}
            >
              <option value="" disabled>
                Choose a .tex root…
              </option>
              {files.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          <span
            className="tex-engine"
            title="This release supports pdfLaTeX with BibTeX."
          >
            pdfLaTeX
          </span>
          <label className="tex-auto-build">
            <input
              type="checkbox"
              checked={tex.autoBuild}
              onChange={(event) => tex.setAutoBuild(event.target.checked)}
            />{' '}
            Rebuild on save
          </label>
        </div>
        {successful?.pdf && (
          <p className={`tex-snapshot-status ${stale ? 'tex-pdf-stale' : ''}`}>
            {stale ? 'Saved snapshot' : 'PDF from saved snapshot'} ·{' '}
            {successful.rootFile}
          </p>
        )}
        {!!warnings?.length && diagnostics(warnings)}
        {build && (
          <div className="tex-log">
            <button
              className="button small subtle"
              aria-expanded={showLog}
              onClick={() => setShowLog((value) => !value)}
            >
              {showLog ? 'Hide build log' : 'Show build log'}
            </button>
            {showLog && (
              <pre tabIndex={0} aria-label="LaTeX build log">
                {build.log?.slice(-64000) || 'Waiting for compiler output…'}
              </pre>
            )}
          </div>
        )}
      </div>
      {tex.status?.available === false && !tex.status.error && (
        <p className="tex-build-error error-message" role="alert">
          LaTeX builds are unavailable. Ask the server administrator to enable
          the TeX worker.
        </p>
      )}
      {(tex.error || tex.status?.error) && (
        <div className="tex-build-error">
          <p className="error-message" role="alert">
            {tex.error || tex.status?.error}
          </p>
          <button className="button small secondary" onClick={tex.retry}>
            Refresh build status
          </button>
        </div>
      )}
      {build?.error && (
        <p className="tex-build-error error-message" role="alert">
          {build.error}
        </p>
      )}
      {!!errors?.length && diagnostics(errors)}
      {successful?.pdf ? (
        <PdfFileViewer
          projectId={projectId}
          path={successful.pdf.filename}
          previewUrl={successful.pdf.url}
          revision={successful.pdf.revision}
          showActions={showOptions}
          fitWidth
        />
      ) : (
        <div className="tex-preview-empty">
          {tex.status === null
            ? 'Checking LaTeX availability…'
            : 'The PDF will appear here after a successful build.'}
        </div>
      )}
    </section>
  )
}
