import type { editor } from 'monaco-editor'
import { createRoot, type Root } from 'react-dom/client'
import { MarkdownProjectImage } from './MarkdownProjectImage'
import { leanCommentImages, type LeanCommentImage } from './leanCommentImages'
import './markdownImages.css'
import './leanCommentImages.css'

const expandedHeight = 240
const collapsedHeight = 30

interface Preview {
  id: string
  zone: editor.IViewZone
  root: Root
}

// View zones reserve display space without inserting source text or changing
// Lean positions. Keep decoded images mounted while ordinary edits move them.
export class LeanCommentImagePreviews {
  private readonly subscriptions: { dispose(): void }[]
  private readonly previews = new Map<string, Preview>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private zoneContainer?: { node: HTMLElement; hidden: string | null }
  private disposed = false

  constructor(
    private readonly editor: editor.IStandaloneCodeEditor,
    private readonly projectId: string,
    private readonly path: string,
    private readonly onOpen: (path: string) => void,
  ) {
    this.subscriptions = [
      editor.onDidChangeModelContent(() => {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.update(), 180)
      }),
      editor.onDidChangeModel(() => {
        this.clear()
        this.update()
      }),
    ]
    this.update()
  }

  private changeZones(
    change: (accessor: editor.IViewZoneChangeAccessor) => void,
  ) {
    const line = this.editor.getVisibleRanges()[0]?.startLineNumber
    const top = line === undefined ? 0 : this.editor.getTopForLineNumber(line)
    const scroll = this.editor.getScrollTop()
    this.editor.changeViewZones(change)
    if (line !== undefined) {
      const shift = this.editor.getTopForLineNumber(line) - top
      if (shift) this.editor.setScrollTop(scroll + shift)
    }
  }

  private update() {
    if (this.disposed) return
    const model = this.editor.getModel()
    const images =
      model && !model.isDisposed()
        ? leanCommentImages(model.getValue(), this.path)
        : []
    const occurrences = new Map<string, number>()
    const next = new Map<string, LeanCommentImage>()
    for (const image of images) {
      const identity = JSON.stringify([image.path, image.alt])
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      next.set(identity + occurrence, image)
    }
    if (
      this.previews.size === next.size &&
      [...next].every(
        ([key, image]) =>
          this.previews.get(key)?.zone.afterLineNumber === image.lineNumber,
      )
    )
      return

    this.changeZones((accessor) => {
      for (const [key, preview] of this.previews) {
        if (next.has(key)) continue
        accessor.removeZone(preview.id)
        preview.root.unmount()
        this.previews.delete(key)
      }
      for (const [key, image] of next) {
        const existing = this.previews.get(key)
        if (existing) {
          existing.zone.afterLineNumber = image.lineNumber
          accessor.layoutZone(existing.id)
        } else this.previews.set(key, this.create(image, accessor))
      }
    })
    if (!this.previews.size) this.restoreAccessibility()
  }

  private create(
    image: LeanCommentImage,
    accessor: editor.IViewZoneChangeAccessor,
  ) {
    const document = this.editor.getDomNode()!.ownerDocument
    const container = document.createElement('section')
    container.className = 'lean-comment-image'
    container.setAttribute(
      'aria-label',
      `Comment image: ${image.alt || image.path}`,
    )
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'lean-comment-image-toggle'
    const content = document.createElement('div')
    content.className = 'lean-comment-image-content'
    const header = document.createElement('div')
    header.className = 'lean-comment-image-header'
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.className = 'lean-comment-image-reload'
    reload.textContent = 'Reload'
    reload.setAttribute('aria-label', `Reload image ${image.alt || image.path}`)
    header.append(toggle, reload)
    container.append(header, content)
    const zone: editor.IViewZone = {
      afterLineNumber: image.lineNumber,
      heightInPx: expandedHeight,
      domNode: container,
      suppressMouseDown: false,
    }
    const id = accessor.addZone(zone)
    // Monaco marks the view-zone container aria-hidden for its usual visual
    // decorations. These zones contain actual images and keyboard controls.
    const parent = container.parentElement
    if (parent && !this.zoneContainer) {
      this.zoneContainer = {
        node: parent,
        hidden: parent.getAttribute('aria-hidden'),
      }
      parent.removeAttribute('aria-hidden')
    }
    let expanded = true
    const updateToggle = () => {
      toggle.textContent = `${expanded ? '▾' : '▸'} ${image.alt || image.path}`
      toggle.setAttribute('aria-expanded', String(expanded))
      toggle.setAttribute(
        'aria-label',
        `${expanded ? 'Hide' : 'Show'} image ${image.alt || image.path}`,
      )
    }
    updateToggle()
    toggle.onclick = () => {
      if (this.disposed) return
      expanded = !expanded
      content.hidden = !expanded
      zone.heightInPx = expanded ? expandedHeight : collapsedHeight
      updateToggle()
      this.changeZones((change) => change.layoutZone(id))
    }
    const root = createRoot(content)
    let revision = 0
    const render = () =>
      root.render(
        <MarkdownProjectImage
          key={revision}
          projectId={this.projectId}
          path={image.path}
          alt={image.alt}
          revision={revision}
          onOpen={() => this.onOpen(image.path)}
        />,
      )
    render()
    reload.onclick = () => {
      if (this.disposed) return
      revision++
      render()
    }
    return { id, zone, root }
  }

  private restoreAccessibility() {
    if (!this.zoneContainer) return
    const { node, hidden } = this.zoneContainer
    if (hidden === null) node.removeAttribute('aria-hidden')
    else node.setAttribute('aria-hidden', hidden)
    this.zoneContainer = undefined
  }

  private clear() {
    this.editor.changeViewZones((accessor) => {
      for (const preview of this.previews.values()) {
        accessor.removeZone(preview.id)
        preview.root.unmount()
      }
    })
    this.previews.clear()
    this.restoreAccessibility()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.subscriptions.forEach((subscription) => subscription.dispose())
    this.clear()
  }
}
