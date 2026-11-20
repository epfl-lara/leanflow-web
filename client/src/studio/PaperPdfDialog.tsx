import { useEffect, useState } from 'react'
import { api, type PaperLink, type TexBuild } from './api'
import { Dialog } from './Dialog'
import { PdfFileViewer } from './PdfFileViewer'
import { texInputInRoot } from './texBuilds'

export interface PaperPdf {
  buildId: string
  path: string
  saved: boolean
}

export function PaperPdfDialog({
  projectId,
  pdf,
  revision,
  dirtyPaths,
  onOpen,
  onClose,
}: {
  projectId: string
  pdf: PaperPdf
  revision: string
  dirtyPaths: ReadonlySet<string>
  onOpen: (location: PaperLink['source'] | PaperLink['target']) => void
  onClose: () => void
}) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/tex/builds/${encodeURIComponent(pdf.buildId)}`
  const [build, setBuild] = useState<TexBuild | null>(null)
  useEffect(() => {
    if (!pdf.saved) return
    const controller = new AbortController()
    void api<TexBuild>(base, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) setBuild(value)
      },
      () => {},
    )
    return () => controller.abort()
  }, [base, pdf.saved])
  const filename =
    build?.pdf?.filename ??
    pdf.path
      .split('/')
      .at(-1)
      ?.replace(/\.tex$/i, '.pdf') ??
    'paper.pdf'
  return (
    <Dialog id="paper-build-preview" title={filename} onClose={onClose}>
      <PdfFileViewer
        projectId={projectId}
        path={filename}
        previewUrl={base + '/pdf'}
        revision={pdf.buildId}
        fitWidth
        onOpenPaperLink={onOpen}
        sourceNavigation={
          pdf.saved
            ? {
                endpoint: base + '/synctex',
                enabled:
                  !!build?.syncTexAvailable &&
                  ![...dirtyPaths].some((path) =>
                    texInputInRoot(build.rootFile, path),
                  ),
                revision,
                dirtyPaths,
                onOpenSource: (path, line) => onOpen({ path, line }),
              }
            : undefined
        }
      />
    </Dialog>
  )
}
