import { editor as monaco, type IMarkdownString } from 'monaco-editor'
import { MarkdownString } from 'vscode/vscode/vs/base/common/htmlContent'
import { declarationKeyword } from '../../../shared/lean-outline-code.mjs'
import type { PaperLink } from './api'
import './paperLinkDecorations.css'

type PaperLocation = PaperLink['source'] | PaperLink['target']
type Destination = { id: string; location: PaperLocation }

let nextCommand = 0

function linkTitle(location: PaperLocation) {
  if ('declaration' in location)
    return `${location.declaration} in ${location.path}`
  if ('page' in location) return `${location.path}, page ${location.page}`
  return location.label
    ? `${location.label} in ${location.path}`
    : `${location.path}, line ${location.line}`
}

function actionTitle(location: PaperLocation) {
  if ('declaration' in location) return 'Open Lean declaration'
  if ('page' in location) return 'Open PDF page'
  return 'Open LaTeX source'
}

function anchorColumns(source: string, label?: string) {
  if (label)
    for (const match of source.matchAll(/(?<!\\)\\label\s*\{([^{}]+)\}/gu))
      if (match[1].trim() === label)
        return [match.index + 1, match.index + match[0].length + 1]

  const keyword = declarationKeyword(source)
  if (keyword) {
    const start = keyword.offset
    const rest = source.slice(start)
    const header = /^\S+(?:\s+(?:«[^»]+»|[^\s:[({]+))?/u.exec(rest)?.[0]
    if (header) return [start + 1, start + header.length + 1]
  }

  return [source.search(/\S/u) + 1, source.trimEnd().length + 1]
}

// The server resolves and validates the saved anchors. Decorations live only
// for the exact editor model version that supplied their source.
export function decoratePaperLinks(
  editor: monaco.IStandaloneCodeEditor,
  model: monaco.ITextModel,
  path: string,
  links: readonly PaperLink[],
  open: (location: PaperLocation) => void,
  showLinks?: () => void,
) {
  const version = model.getVersionId()
  const edition = ++nextCommand
  const commandId = `leanflow.paperLink.${edition}`
  const groups = new Map<
    number,
    { label?: string; destinations: Destination[] }
  >()
  const destinations = new Map<string, PaperLocation>()
  for (const { id, source, target, status } of links) {
    if (status !== 'current') continue
    const fromPaper = source.path === path && 'line' in source
    if (!fromPaper && target.path !== path) continue
    const line = fromPaper ? source.line : target.line
    if (line < 1 || line > model.getLineCount()) continue
    const group = groups.get(line) ?? {
      label: fromPaper ? source.label : undefined,
      destinations: [],
    }
    const location = fromPaper ? target : source
    group.destinations.push({ id, location })
    groups.set(line, group)
    destinations.set(id, location)
  }
  if (!groups.size) return
  const { above } = editor.getOption(monaco.EditorOption.hover)
  // The workbench clips widgets that extend above the first lines of source.
  if (above) editor.updateOptions({ hover: { above: false } })

  const current = () =>
    editor.getModel() === model && model.getVersionId() === version
  const follow = (line: number) => {
    if (!current()) return
    const group = groups.get(line)
    if (group?.destinations.length === 1) open(group.destinations[0].location)
    else if (group) showLinks?.()
  }
  const command = monaco.addCommand({
    id: commandId,
    run(_accessor, id: unknown) {
      const location = typeof id === 'string' ? destinations.get(id) : undefined
      if (location && current()) open(location)
    },
  })
  const collection = editor.createDecorationsCollection(
    [...groups].flatMap(([line, { label, destinations }]) => {
      const [startColumn, endColumn] = anchorColumns(
        model.getLineContent(line),
        label,
      )
      if (!startColumn || endColumn <= startColumn) return []
      const hoverMessage: IMarkdownString[] = destinations.map(
        ({ id, location }) =>
          new MarkdownString('', {
            isTrusted: { enabledCommands: [commandId] },
          })
            .appendText(linkTitle(location))
            .appendMarkdown('  \n')
            .appendLink(
              `command:${commandId}?${encodeURIComponent(JSON.stringify([id]))}`,
              actionTitle(location),
            ),
      )
      return [
        {
          range: {
            startLineNumber: line,
            endLineNumber: line,
            startColumn,
            endColumn,
          },
          options: {
            inlineClassName: 'paper-editor-anchor',
            hoverMessage,
            stickiness:
              monaco.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            after: {
              content: '\u00a0↗\u00a0',
              inlineClassName: `paper-editor-jump paper-editor-jump-${line}`,
              inlineClassNameAffectsLetterSpacing: true,
              cursorStops: monaco.InjectedTextCursorStops.None,
            },
          },
        },
      ]
    }),
  )
  const root = editor.getDomNode()
  const markerLine = (event: MouseEvent) => {
    const target = event.target
    if (event.button !== 0 || !(target instanceof Element)) return
    const label = target.closest('.paper-editor-jump')?.classList.value
    return label && Number(/\bpaper-editor-jump-(\d+)\b/u.exec(label)?.[1])
  }
  const preserveMarker = (event: PointerEvent) => {
    if (!markerLine(event) || !current()) return
    // Monaco repaints injected text when a pointer press moves its selection.
    // Leave the marker in place until the browser dispatches its click.
    event.preventDefault()
    event.stopPropagation()
  }
  const click = (event: MouseEvent) => {
    const line = markerLine(event)
    if (line) follow(line)
  }
  root?.addEventListener('pointerdown', preserveMarker, true)
  root?.addEventListener('click', click)
  const actionContext = editor.createContextKey<boolean>(
    'leanflowHasPaperLink',
    false,
  )
  const syncContext = () =>
    actionContext.set(
      current() && groups.has(editor.getPosition()?.lineNumber ?? 0),
    )
  const cursor = editor.onDidChangeCursorPosition(syncContext)
  const content = editor.onDidChangeModelContent(syncContext)
  syncContext()
  const action = editor.addAction({
    id: `leanflow.followPaperLink.${edition}`,
    label: 'Follow Paper Link',
    precondition: 'leanflowHasPaperLink',
    contextMenuGroupId: 'navigation',
    run: () => follow(editor.getPosition()?.lineNumber ?? 0),
  })
  return () => {
    action.dispose()
    actionContext.reset()
    content.dispose()
    cursor.dispose()
    root?.removeEventListener('pointerdown', preserveMarker, true)
    root?.removeEventListener('click', click)
    command.dispose()
    if (!model.isDisposed()) {
      collection.clear()
      if (above) editor.updateOptions({ hover: { above } })
    }
  }
}
