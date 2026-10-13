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
  kind?: ProofDeclarationKind
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export type ProofDeclarationKind =
  | 'theorem'
  | 'lemma'
  | 'def'
  | 'example'
  | 'import'
  | 'structure'
  | 'inductive'
  | 'abbrev'
  | 'instance'
  | 'other'

export interface EditorProofState {
  path: string
  lineCount?: number
  declarations: ProofDeclaration[]
  status: 'loading' | 'ready' | 'unavailable'
  target: ProofTarget | null
  error?: string
  disabled: boolean
  readOnly: boolean
}

export interface ProofEditorRequest {
  id: number
  path?: string
  declaration?: ProofDeclaration
  lines?: { startLine: number; endLine: number }
  mode?: ChatMode
}

export interface EditorSelection {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export const MAX_PROOF_SOURCE_LENGTH = 64_000

// This lexical mask only labels ranges already supplied by Lean and recognizes
// the import header. It never guesses the extent of a proof. Keeping newlines
// and UTF-16 offsets intact lets masked source retain the editor's coordinates.
function outlineCode(content: string): string {
  const characters = content.split('')
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (characters[index] !== '\n' && characters[index] !== '\r')
        characters[index] = ' '
    }
  }
  let index = 0
  let quotationDepth = 0
  while (index < content.length) {
    const start = index
    if (content.startsWith('--', index)) {
      while (index < content.length && content[index] !== '\n') index++
      blank(start, index)
    } else if (content.startsWith('/-', index)) {
      let depth = 1
      index += 2
      while (index < content.length && depth) {
        if (content.startsWith('/-', index)) {
          depth++
          index += 2
        } else if (content.startsWith('-/', index)) {
          depth--
          index += 2
        } else index++
      }
      blank(start, index)
    } else if (content[index] === '"') {
      index++
      while (index < content.length) {
        if (content[index] === '\\') index += 2
        else if (content[index++] === '"') break
      }
      blank(start, Math.min(index, content.length))
    } else if (
      content[index] === "'" &&
      !/[\p{L}\p{N}_']/u.test(content[index - 1] || '')
    ) {
      const character =
        /^'(?:\\(?:u\{[0-9a-fA-F]+\}|[^\r\n])|[^'\\\r\n])'/.exec(
          content.slice(index),
        )?.[0]
      if (character) {
        index += character.length
        blank(start, index)
      } else {
        if (quotationDepth) blank(index, index + 1)
        index++
      }
    } else if (content[index] === '«') {
      // A quoted identifier such as «theorem» is not a declaration keyword.
      while (index < content.length && content[index++] !== '»') {
        // Scan through the identifier, including embedded punctuation.
      }
      blank(start, index)
    } else if (content[index] === '`') {
      while (content[index] === '`') index++
      if (content[index] === '(') {
        quotationDepth++
        blank(start, ++index)
      } else {
        while (
          index < content.length &&
          /[\p{L}\p{N}_'.]/u.test(content[index])
        )
          index++
        blank(start, index)
      }
    } else if (quotationDepth) {
      if (content[index] === '(') quotationDepth++
      if (content[index] === ')') quotationDepth--
      blank(index, index + 1)
      index++
    } else index++
  }
  return characters.join('')
}

const declarationKinds = new Set<ProofDeclarationKind>([
  'theorem',
  'lemma',
  'def',
  'example',
  'structure',
  'inductive',
  'abbrev',
  'instance',
])

function declarationKind(source: string): ProofDeclarationKind {
  // Skip attributes and modifiers before looking at the command's first token.
  // A keyword in the body, type or a quotation must not classify the command.
  let index = 0
  while (index < source.length) {
    while (/\s/.test(source[index] || '') && index < source.length) index++
    if (source.startsWith('@[', index)) {
      let depth = 1
      index += 2
      while (index < source.length && depth) {
        if (source[index] === '[') depth++
        if (source[index] === ']') depth--
        index++
      }
      continue
    }
    const token = /^[\p{L}_][\p{L}\p{N}_']*/u.exec(source.slice(index))?.[0]
    if (!token) return 'other'
    if (
      [
        'private',
        'protected',
        'noncomputable',
        'unsafe',
        'partial',
        'public',
        'meta',
        'nonrec',
      ].includes(token)
    ) {
      index += token.length
      continue
    }
    return declarationKinds.has(token as ProofDeclarationKind)
      ? (token as ProofDeclarationKind)
      : 'other'
  }
  return 'other'
}

function importDeclarations(code: string): ProofDeclaration[] {
  const result: ProofDeclaration[] = []
  const lines = code.split('\n')
  for (let line = 0; line < lines.length; line++) {
    const source = lines[line]
    const trimmed = source.trim()
    if (!trimmed || /^(?:prelude|module)$/.test(trimmed)) continue
    const match =
      /^(?:(?:public|private|meta)\s+)*import\s+([\p{L}_][\p{L}\p{N}_'.]*(?:\s+[\p{L}_][\p{L}\p{N}_'.]*)*)\s*$/u.exec(
        trimmed,
      )
    // Lean's imports form a header, before definitions or namespace commands.
    if (!match) break
    result.push({
      name: match[1],
      kind: 'import',
      startLine: line + 1,
      startColumn: source.search(/\S/) + 1,
      endLine: line + 1,
      endColumn: source.trimEnd().length + 1,
    })
  }
  return result
}

// Lean supplies parsed command ranges, including attributes and nested tactic
// blocks. Do not guess declaration boundaries from regular expressions: comments,
// strings, quotations and unfinished proofs can all contain declaration keywords.
export function proofDeclarations(
  symbols: unknown,
  uri: string,
  lineCount: number,
  content?: string,
): ProofDeclaration[] {
  const result: ProofDeclaration[] = []
  const code =
    content === undefined
      ? undefined
      : outlineCode(content.replace(/\r\n?/g, '\n'))
  const lines = code?.split('\n')
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
          ...(lines
            ? {
                kind: declarationKind(
                  lines
                    .slice(start.line, end.line + 1)
                    .map((line, index) =>
                      line.slice(
                        index ? 0 : start.character,
                        start.line + index === end.line
                          ? end.character
                          : undefined,
                      ),
                    )
                    .join('\n'),
                ),
              }
            : {}),
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
  if (code !== undefined) {
    for (const item of importDeclarations(code)) {
      if (item.startLine > lineCount) continue
      if (
        !result.some(
          (existing) =>
            existing.startLine === item.startLine &&
            existing.startColumn === item.startColumn,
        )
      )
        result.push(item)
    }
  }
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
    .filter((item) => item.kind !== 'import' && contains(item))
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
