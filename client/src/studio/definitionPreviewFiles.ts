import {
  EmptyFileSystemProvider,
  FilePermission,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  registerFileSystemOverlay,
} from '@codingame/monaco-vscode-files-service-override'
import type { Uri } from 'monaco-editor'
import { api } from './api'

const projectPath = (resource?: Uri) =>
  resource?.path.startsWith('/workspace/') &&
  !resource.path.startsWith('/workspace/.lake/')
    ? resource.path.slice('/workspace/'.length)
    : null

// Monaco reads destination text to preview a definition before clicking it.
// Fall back to authenticated source reads behind its existing browser files,
// so an editor draft always wins and previews never write to the project.
export class DefinitionPreviewFiles extends EmptyFileSystemProvider {
  private controller = new AbortController()
  private reads = new Map<string, Promise<Uint8Array>>()
  private registration: ReturnType<typeof registerFileSystemOverlay>
  constructor(private projectId: string) {
    super()
    this.registration = registerFileSystemOverlay(-1, this)
  }
  private async content(resource?: Uri) {
    if (this.controller.signal.aborted) return new Uint8Array()
    if (
      !resource ||
      resource.scheme !== 'file' ||
      resource.authority ||
      resource.query ||
      resource.fragment ||
      (!resource.path.endsWith('.lean') &&
        !(
          resource.path.startsWith('/workspace/.lake/packages/') &&
          /\.(md|toml)$/.test(resource.path)
        ))
    )
      throw FileSystemProviderError.create(
        'Not a source preview.',
        FileSystemProviderErrorCode.FileNotFound,
      )
    const uri = resource.toString()
    let pending = this.reads.get(uri)
    if (!pending) {
      const filename = resource.path.startsWith('/workspace/')
        ? resource.path.slice('/workspace/'.length)
        : null
      pending = api<{ content: string }>(
        `/api/projects/${encodeURIComponent(this.projectId)}/${filename ? `file?path=${encodeURIComponent(filename)}` : 'library-source'}`,
        {
          signal: this.controller.signal,
          ...(filename
            ? {}
            : { method: 'POST', body: JSON.stringify({ uri, line: 1 }) }),
        },
      ).then(
        (source) => new TextEncoder().encode(source.content),
        // A missing preview must not reject Monaco's unhandled preview promise.
        // Clicking still opens the normal source viewer and its actionable error.
        () => new Uint8Array(),
      )
      this.reads.set(uri, pending)
      // A cancelled hover can request stat without ever consuming readFile.
      const oldest = this.reads.keys().next().value
      if (this.reads.size > 8 && oldest) this.reads.delete(oldest)
    }
    const bytes = await pending
    return this.controller.signal.aborted ? new Uint8Array() : bytes
  }
  override async stat(resource?: Uri) {
    const bytes = await this.content(resource)
    return {
      type: FileType.File,
      // Project models must remain writable in Monaco's memory filesystem.
      // All writes still go to its existing memory provider, never this API.
      permissions: projectPath(resource) ? undefined : FilePermission.Readonly,
      size: bytes.byteLength,
      ctime: 0,
      mtime: 0,
    }
  }
  override async readFile(resource?: Uri) {
    const bytes = await this.content(resource)
    if (resource) this.reads.delete(resource.toString())
    return bytes
  }
  dispose() {
    this.controller.abort()
    this.reads.clear()
    this.registration.dispose()
  }
}
