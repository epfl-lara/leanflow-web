/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to focus this scrollable document. */
import { useCallback, useMemo, useState } from 'react'
import type { FileEntry } from './api'
import { OutputText } from './AssistantText'
import { markdownProjectPath, MAX_MARKDOWN_PREVIEW_BYTES } from './fileReading'

export function MarkdownFilePreview({
  path,
  content,
  files,
  onOpenFile,
}: {
  path: string
  content: string
  files: FileEntry[]
  onOpenFile: (path: string) => void
}) {
  const [error, setError] = useState('')
  const tooLarge = useMemo(
    () =>
      new TextEncoder().encode(content).byteLength > MAX_MARKDOWN_PREVIEW_BYTES,
    [content],
  )
  const openLink = useCallback(
    (href: string) => {
      const destination = markdownProjectPath(path, href)
      if (!destination || !files.some((file) => file.path === destination)) {
        setError(
          'This linked file is not in the project. Upload it to open it here.',
        )
        return
      }
      setError('')
      if (destination !== path) onOpenFile(destination)
    },
    [path, files, onOpenFile],
  )

  return (
    <section
      className="markdown-file-preview markdown-body"
      aria-label="Markdown preview"
      tabIndex={0}
    >
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {tooLarge ? (
        <output>
          This document exceeds the 512 KiB preview limit. Use Edit Markdown to
          read and edit the source.
        </output>
      ) : (
        <OutputText text={content} onOpenLocalLink={openLink} />
      )}
    </section>
  )
}
