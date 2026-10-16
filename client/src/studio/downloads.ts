import { saveAs } from 'file-saver'
import { apiDownload } from './api'

export async function downloadWorkspaceFile(
  projectId: string,
  path: string,
  filename = path.split('/').at(-1) || 'download',
) {
  const download = await apiDownload(
    `/api/projects/${encodeURIComponent(projectId)}/download?${new URLSearchParams({ path })}`,
  )
  saveAs(download.blob, filename)
}

export async function downloadProject(projectId: string, projectName: string) {
  const download = await apiDownload(
    `/api/projects/${encodeURIComponent(projectId)}/download`,
  )
  saveAs(download.blob, download.filename || `${projectName}.zip`)
}
