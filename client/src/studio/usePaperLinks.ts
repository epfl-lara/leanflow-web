import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from 'react'
import {
  api,
  errorText,
  type FileEntry,
  type OpenFile,
  type PaperLink,
} from './api'
import { isPdfFile } from '../../../shared/file-previews.mjs'
import { PAPER_LINKS_FILE } from '../../../shared/paper-links.mjs'
import { isTexFile } from '../../../shared/tex.mjs'

type PaperLinkResult = { links: PaperLink[] } | { error: string }

interface Evidence {
  files: readonly FileEntry[]
  entries: ReadonlyMap<string, FileEntry>
  buffers: ReadonlyMap<string, OpenFile>
}

function fingerprint(
  path: string | null,
  links: readonly PaperLink[] | undefined,
  { files, entries, buffers }: Evidence,
) {
  const paths = new Set<string>([PAPER_LINKS_FILE])
  if (path) paths.add(path)
  // A newly saved TeX reference can add a reverse link to this Lean file.
  if (path?.endsWith('.lean'))
    for (const { path } of files) if (isTexFile(path)) paths.add(path)
  for (const { source, target } of links || []) {
    paths.add(source.path)
    paths.add(target.path)
  }
  let needsFileList = false
  const key = JSON.stringify(
    [...paths].sort().map((name) => {
      const entry = entries.get(name)
      if (entry && entry.revision === undefined) needsFileList = true
      const buffer = buffers.get(name)
      return [
        name,
        entry ? (entry.revision ?? '') : null,
        buffer?.hash ?? null,
        buffer?.unavailable === true,
      ]
    }),
  )
  return { key, fileList: needsFileList ? files : undefined }
}

export function usePaperLinks({
  accountId,
  projectId,
  path,
  files,
  buffers,
}: {
  accountId?: string
  projectId?: string | null
  path: string | null
  files: readonly FileEntry[]
  buffers: ReadonlyMap<string, OpenFile>
}) {
  const [attempt, setAttempt] = useState(0)
  const revisions = useMemo(
    () =>
      JSON.stringify(
        files.flatMap(({ path, revision }) =>
          path === PAPER_LINKS_FILE ||
          isPdfFile(path) ||
          isTexFile(path) ||
          path.endsWith('.lean')
            ? [[path, revision]]
            : [],
        ),
      ),
    [files],
  )
  const entries = useMemo(
    () => new Map(files.map((entry) => [entry.path, entry])),
    [files],
  )
  const documentKey = JSON.stringify([accountId, projectId, path])
  const [loaded, setLoaded] = useState<{
    documentKey: string
    attempt: number
    evidence: ReturnType<typeof fingerprint>
    result: PaperLinkResult
    previousLinks?: PaperLink[]
  } | null>(null)
  const sameDocument = loaded?.documentKey === documentKey ? loaded : null
  const previousLinks = sameDocument?.previousLinks
  const { key, fileList } = useMemo(
    () => fingerprint(path, previousLinks, { files, entries, buffers }),
    [path, previousLinks, files, entries, buffers],
  )
  const settled =
    !!sameDocument &&
    sameDocument.attempt === attempt &&
    sameDocument.evidence.key === key &&
    sameDocument.evidence.fileList === fileList
  const result = settled ? sameDocument.result : null
  const snapshotEvidence = useEffectEvent(() => ({ files, entries, buffers }))
  useEffect(() => {
    if (!accountId || !projectId || !path || settled) return
    const controller = new AbortController()
    // New endpoints arrive with the lookup. Compare their request-time file
    // versions against current evidence before publishing active controls.
    const captured = snapshotEvidence()
    void api<{ links: PaperLink[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/paper-links?${new URLSearchParams({ path })}`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!controller.signal.aborted)
          setLoaded({
            documentKey,
            attempt,
            evidence: fingerprint(path, response.links, captured),
            result: response,
            previousLinks: response.links,
          })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded((previous) => ({
            documentKey,
            attempt,
            evidence: { key, fileList },
            result: { error: errorText(error) },
            previousLinks:
              previous?.documentKey === documentKey
                ? previous.previousLinks
                : undefined,
          }))
      })
    return () => controller.abort()
  }, [accountId, projectId, path, documentKey, attempt, key, fileList, settled])
  const refresh = useCallback(() => setAttempt((current) => current + 1), [])
  return { result, previousLinks, refresh, revision: revisions }
}
