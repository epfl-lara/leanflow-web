import { Range, editor as monacoEditor, type IPosition } from 'monaco-editor'
import {
  collaboratorHue,
  type ProjectPeer,
  type ProjectSelection,
} from './projectPresence'
import './collaboratorCursors.css'

function labelTextColor(hue: number) {
  // Bright yellow/green identities need dark lettering; blue/purple need white.
  // Choose from the rendered HSL color's relative luminance, not the hue alone.
  const saturation = 0.68,
    lightness = 0.42
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12
    const value =
      lightness -
      saturation *
        Math.min(lightness, 1 - lightness) *
        Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4)
  return luminance > 0.179 ? '#000' : '#fff'
}

export class CollaboratorCursors {
  private readonly decorations: monacoEditor.IEditorDecorationsCollection
  private readonly styles: HTMLStyleElement
  private readonly subscriptions: { dispose(): void }[]
  private widgets: monacoEditor.IContentWidget[] = []
  private disposed = false

  constructor(
    private readonly editor: monacoEditor.IStandaloneCodeEditor,
    private readonly path: string,
    private readonly onSelection: (selection: ProjectSelection | null) => void,
  ) {
    this.decorations = editor.createDecorationsCollection()
    this.styles = editor.getDomNode()!.ownerDocument.createElement('style')
    editor.getDomNode()!.append(this.styles)
    this.subscriptions = [
      editor.onDidChangeCursorSelection(() => this.publish()),
      editor.onDidFocusEditorText(() => this.publish()),
      editor.onDidBlurEditorText(() => onSelection(null)),
      editor.onDidChangeModelContent(() => {
        for (const widget of this.widgets) editor.layoutContentWidget(widget)
      }),
    ]
    this.publish()
  }

  private publish() {
    const model = this.editor.getModel()
    const selection = this.editor.getSelection()
    if (this.disposed || !model || !selection || !this.editor.hasTextFocus())
      return
    this.onSelection({
      path: this.path,
      anchor: model.getOffsetAt(selection.getSelectionStart()),
      head: model.getOffsetAt(selection.getPosition()),
    })
  }

  update(peers: readonly ProjectPeer[]) {
    if (this.disposed) return
    for (const widget of this.widgets) this.editor.removeContentWidget(widget)
    this.widgets = []
    const model = this.editor.getModel()
    if (!model) return
    const decorations: monacoEditor.IModelDeltaDecoration[] = []
    const rules = new Set<string>()
    const groups = new Map<
      number,
      {
        head: IPosition
        cursorIndex: number
        labels: HTMLSpanElement[]
      }
    >()
    for (const peer of peers) {
      if (peer.path !== this.path) continue
      const hue = collaboratorHue(peer.userId)
      const color = `hsl(${hue} 68% 42%)`
      const colorClass = `collaborator-color-${hue}`
      rules.add(
        `.monaco-host .collaborator-cursor.${colorClass}{border-color:hsl(${hue} 68% 30%)}`,
      )
      rules.add(
        `:root[data-theme='dark'] .monaco-host .collaborator-cursor.${colorClass}{border-color:hsl(${hue} 78% 70%)}`,
      )
      rules.add(
        `.monaco-host .collaborator-selection.${colorClass}{background:hsl(${hue} 68% 52% / 12%)}`,
      )
      const anchor = model.getPositionAt(peer.anchor)
      const head = model.getPositionAt(peer.head)
      if (peer.anchor !== peer.head)
        decorations.push({
          range: Range.fromPositions(anchor, head),
          options: { inlineClassName: `collaborator-selection ${colorClass}` },
        })
      const cursorIndex = decorations.length
      decorations.push({
        range: Range.fromPositions(head),
        options: {
          beforeContentClassName: `collaborator-cursor ${colorClass}`,
          showIfCollapsed: true,
          stickiness:
            monacoEditor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          zIndex: 10,
        },
      })
      const label = this.styles.ownerDocument.createElement('span')
      label.className = 'collaborator-cursor-label'
      label.textContent = peer.name
      label.style.backgroundColor = color
      label.style.color = labelTextColor(hue)
      label.title = peer.name
      const group = groups.get(peer.head)
      if (group) group.labels.push(label)
      else groups.set(peer.head, { head, cursorIndex, labels: [label] })
    }
    for (const [offset, group] of groups) {
      // People at the same text position share a wrapping row so each name
      // remains visible while their separate carets and selections are kept.
      const names = this.styles.ownerDocument.createElement('div')
      names.className = 'collaborator-cursor-group'
      names.append(...group.labels)
      // Monaco sets a widget node's inline maxWidth to the editor width.
      // Keep our truncated name inside that node so the label cap survives.
      const container = this.styles.ownerDocument.createElement('div')
      container.style.pointerEvents = 'none'
      container.append(names)
      const widget: monacoEditor.IContentWidget = {
        getId: () => `collaborators-${offset}`,
        getDomNode: () => container,
        suppressMouseDown: true,
        getPosition: () => ({
          position:
            this.decorations.getRange(group.cursorIndex)?.getStartPosition() ||
            group.head,
          preference: [
            monacoEditor.ContentWidgetPositionPreference.ABOVE,
            monacoEditor.ContentWidgetPositionPreference.BELOW,
          ],
        }),
      }
      this.widgets.push(widget)
    }
    this.styles.textContent = [...rules].join('\n')
    this.decorations.set(decorations)
    for (const widget of this.widgets) this.editor.addContentWidget(widget)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const subscription of this.subscriptions) subscription.dispose()
    for (const widget of this.widgets) this.editor.removeContentWidget(widget)
    this.decorations.clear()
    this.styles.remove()
    this.onSelection(null)
  }
}
