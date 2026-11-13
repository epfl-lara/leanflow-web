import { createContext, useContext, useState } from 'react'
import { sessionBoundUrl } from './api'

// An image already inside a Markdown link uses that link's keyboard action.
export const MarkdownImageLinkContext = createContext(false)

export function MarkdownProjectImage({
  projectId,
  path,
  alt,
  onOpen,
  revision,
}: {
  projectId: string
  path: string
  alt?: string
  onOpen?: () => void
  revision?: number
}) {
  const linked = useContext(MarkdownImageLinkContext)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const source = sessionBoundUrl(
    `/api/projects/${encodeURIComponent(projectId)}/file-preview?path=${encodeURIComponent(path)}${
      revision === undefined && !attempt
        ? ''
        : `&previewRevision=${revision ?? 0}-${attempt}`
    }`,
  )
  const failed = failedSource === source
  const image = failed ? (
    <span className="markdown-image-error">
      This image could not load. Open the project file or retry the image.
    </span>
  ) : (
    <img
      key={attempt}
      src={source}
      alt={alt || path.split('/').at(-1) || 'Project image'}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSource(source)}
    />
  )

  return (
    <span className="markdown-project-image">
      {onOpen && !linked ? (
        <button
          type="button"
          className="markdown-project-image-open"
          aria-label={`Open image ${path}`}
          onClick={onOpen}
        >
          {image}
          <span className="markdown-image-caption">{alt || path}</span>
        </button>
      ) : (
        <>
          {image}
          <span className="markdown-image-caption">{alt || path}</span>
        </>
      )}
      {failed && !linked && (
        <button
          type="button"
          className="button small secondary"
          onClick={() => {
            setFailedSource(null)
            setAttempt((current) => current + 1)
          }}
        >
          Retry image
        </button>
      )}
    </span>
  )
}
