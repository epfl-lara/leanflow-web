import type { ChatMode } from './chatModes'

export interface ProofTarget {
  path: string
  startLine: number
  endLine: number
  name?: string
  source: string
}

export interface ProofFocusRequest {
  id: number
  projectId: string
  target: ProofTarget
  mode?: ChatMode
}

export interface ProofDeclaration {
  name: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface EditorSelection {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export const MAX_PROOF_SOURCE_LENGTH = 64_000

// Lean supplies parsed command ranges, including attributes and nested tactic
// blocks. Do not guess declaration boundaries from regular expressions: comments,
// strings, quotations and unfinished proofs can all contain declaration keywords.
export function proofDeclarations(
  symbols: unknown,
  uri: string,
  lineCount: number,
): ProofDeclaration[] {
  const result: ProofDeclaration[] = []
  const visit = (items: unknown, prefix = '', depth = 0) => {
    if (!Array.isArray(items) || depth > 64) return
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const symbol = item as {
        name?: unknown
        kind?: unknown
        range?: unknown
        children?: unknown
        location?: { uri?: unknown; range?: unknown }
      }
      const name = typeof symbol.name === 'string' ? symbol.name : ''
      // LSP kinds: Module, Namespace and Package are containers, not proofs.
      const container = [2, 3, 4].includes(Number(symbol.kind))
      const displayName = prefix && name ? `${prefix}.${name}` : name
      const range = (symbol.range ?? symbol.location?.range) as
        | {
            start?: { line: number; character: number }
            end?: { line: number; character: number }
          }
        | undefined
      const start = range?.start
      const end = range?.end
      if (
        !container &&
        name &&
        start &&
        end &&
        (!symbol.location?.uri || symbol.location.uri === uri) &&
        [start.line, start.character, end.line, end.character].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) &&
        start.line < lineCount &&
        end.line < lineCount &&
        (end.line > start.line ||
          (end.line === start.line && end.character > start.character))
      ) {
        result.push({
          name: displayName,
          startLine: start.line + 1,
          startColumn: start.character + 1,
          endLine: end.line + 1,
          endColumn: end.character + 1,
        })
      }
      const childPrefix =
        container && name && name !== '<section>' ? displayName : prefix
      visit(symbol.children, childPrefix, depth + 1)
    }
  }
  visit(symbols)
  return result.sort(
    (a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn,
  )
}

export function proofTargetForSelection(
  path: string,
  content: string,
  selection: EditorSelection | null,
  declarations: ProofDeclaration[],
): { target: ProofTarget | null; error?: string } {
  if (!selection) return { target: null }
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const nonempty =
    selection.startLineNumber !== selection.endLineNumber ||
    selection.startColumn !== selection.endColumn
  const contains = (declaration: ProofDeclaration) => {
    const line = selection.startLineNumber
    const column = selection.startColumn
    return (
      (line > declaration.startLine ||
        (line === declaration.startLine &&
          column >= declaration.startColumn)) &&
      (line < declaration.endLine ||
        (line === declaration.endLine && column <= declaration.endColumn))
    )
  }
  const declaration = declarations
    .filter(contains)
    .sort(
      (a, b) =>
        a.endLine - a.startLine - (b.endLine - b.startLine) ||
        a.endColumn - a.startColumn - (b.endColumn - b.startColumn),
    )[0]
  if (!nonempty && !declaration) return { target: null }
  const range = nonempty
    ? selection
    : {
        startLineNumber: declaration.startLine,
        startColumn: declaration.startColumn,
        endLineNumber: declaration.endLine,
        endColumn: declaration.endColumn,
      }
  const startLine = range.startLineNumber
  // A selection ending at column 1 does not include that next line.
  const endLine =
    range.endLineNumber > startLine && range.endColumn === 1
      ? range.endLineNumber - 1
      : range.endLineNumber
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  )
    return { target: null }
  const source = lines.slice(startLine - 1, endLine).join('\n')
  if (source.length > MAX_PROOF_SOURCE_LENGTH)
    return {
      target: null,
      error: 'This selection is too large. Select fewer lines to focus Lemex.',
    }
  if (!source.trim()) return { target: null }
  const named =
    declaration &&
    startLine >= declaration.startLine &&
    endLine <= declaration.endLine
      ? declaration.name
      : undefined
  return {
    target: {
      path,
      startLine,
      endLine,
      ...(named ? { name: named } : {}),
      source,
    },
  }
}
