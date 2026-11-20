import type { TexBuild, TexStatus } from './api'
import { isTexInputFile } from '../../../shared/tex.mjs'

export function texLanguage(path?: string): 'latex' | 'tex' | 'bibtex' | null {
  if (!path) return null
  if (/\.(?:tex|ltx|ctx)$/i.test(path)) return 'latex'
  if (/\.(?:sty|cls|bbx|cbx)$/i.test(path)) return 'tex'
  if (/\.bib$/i.test(path)) return 'bibtex'
  return null
}

export function defaultTexRoot(paths: string[], currentPath?: string) {
  return (
    paths.find((path) => /^main\.tex$/i.test(path)) ||
    paths.find((path) => path === currentPath) ||
    (paths.length === 1 ? paths[0] : '')
  )
}

export const texBuildIsActive = (build?: TexBuild | null) =>
  !!build &&
  (build.cleanupFailed === true ||
    ['queued', 'starting', 'running', 'stopping'].includes(build.status))

export function texInputInRoot(rootFile: string, path: string) {
  const folder = rootFile.slice(0, rootFile.lastIndexOf('/') + 1)
  return !!rootFile && path.startsWith(folder) && isTexInputFile(path)
}

interface ObservedTexPdf {
  id: string
  saveVersion: number
  published: boolean
}

export function observeTexPdf(
  status: TexStatus,
  polledSave: number,
  submitted: ReadonlyMap<string, number>,
  previous: ObservedTexPdf | null,
): ObservedTexPdf | null {
  const pdf = status.lastSuccessful
  if (!pdf) return null
  // Editor saves and paper publication are delivered independently. The saved
  // workspace stamp confirms that a previously displayed PDF still covers a save.
  const published =
    pdf.origin === 'agent' &&
    !!pdf.workspaceRevision &&
    pdf.workspaceRevision === status.workspaceRevision
  const known =
    submitted.get(pdf.id) ??
    (previous?.id === pdf.id ? previous.saveVersion : undefined)
  return {
    id: pdf.id,
    saveVersion: published ? polledSave : (known ?? polledSave),
    published,
  }
}

export function texPdfIsStale(
  status: TexStatus | null,
  rootFile: string,
  dirty: boolean,
  savedSinceBuild: boolean,
) {
  const build = status?.lastSuccessful
  return (
    !!build?.pdf &&
    (dirty ||
      savedSinceBuild ||
      build.rootFile !== rootFile ||
      (!!build.workspaceRevision &&
        status?.workspaceRevision !== build.workspaceRevision))
  )
}
