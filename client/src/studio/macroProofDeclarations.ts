import {
  containerNamespace,
  declarationKeyword,
  placeholderWarning,
  type ProofDeclaration,
} from './proofTarget.ts'

type Position = { line: number; character: number }
type Keyword = {
  kind: 'theorem' | 'lemma' | 'example'
  name: string
  position: Position
  offset: number
}
type Range = { start: Position; end: Position }

function position(value: unknown): value is Position {
  return (
    !!value &&
    typeof value === 'object' &&
    'line' in value &&
    'character' in value &&
    typeof value.line === 'number' &&
    Number.isSafeInteger(value.line) &&
    value.line >= 0 &&
    typeof value.character === 'number' &&
    Number.isSafeInteger(value.character) &&
    value.character >= 0
  )
}

function range(value: unknown): value is Range {
  return (
    !!value &&
    typeof value === 'object' &&
    'start' in value &&
    'end' in value &&
    position(value.start) &&
    position(value.end)
  )
}

function missingKeywords(
  code: string,
  source: string,
  lines: number[],
  known: ProofDeclaration[],
) {
  const result: Keyword[] = []
  const pattern =
    /(?<![\p{L}\p{M}\p{N}_'.])(?:theorem|lemma|example)(?![\p{L}\p{M}\p{N}_'.])/gu
  const ident =
    /^(?:«[^»\n]+»|[\p{L}_][\p{L}\p{M}\p{N}_']*)(?:\.(?:«[^»\n]+»|[\p{L}_][\p{L}\p{M}\p{N}_']*))*/u
  let line = 0,
    cursor = 0
  for (const match of code.matchAll(pattern)) {
    const offset = match.index
    while (line + 1 < lines.length && lines[line + 1] <= offset) line++
    while (
      cursor < known.length &&
      lines[known[cursor].endLine - 1] + known[cursor].endColumn - 1 <= offset
    )
      cursor++
    const containing = known[cursor]
    if (
      containing &&
      lines[containing.startLine - 1] + containing.startColumn - 1 <= offset
    )
      continue
    const kind = match[0]
    if (kind !== 'lemma' && kind !== 'theorem' && kind !== 'example') continue
    let name = kind === 'example' ? 'example' : ''
    if (!name) {
      let nameOffset = offset + kind.length
      while (
        nameOffset < code.length &&
        /\s/u.test(code[nameOffset]) &&
        source[nameOffset] !== '«'
      )
        nameOffset++
      name = ident.exec(source.slice(nameOffset))?.[0] || ''
    }
    if (name)
      result.push({
        kind,
        name,
        offset,
        position: { line, character: offset - lines[line] },
      })
  }
  return result
}

function namespace(
  symbols: unknown,
  point: Position,
  code: string,
  starts: number[],
  depth = 0,
): string {
  if (!Array.isArray(symbols) || depth > 64) return ''
  for (const item of symbols) {
    if (!item || ![2, 3, 4].includes(item.kind) || !range(item.range)) continue
    const { start, end } = item.range
    if (
      start.line > point.line ||
      (start.line === point.line && start.character > point.character) ||
      end.line < point.line ||
      (end.line === point.line && end.character < point.character)
    )
      continue
    const opening = code.slice(
      starts[start.line] + start.character,
      starts[start.line + 1],
    )
    const prefix =
      typeof item.name === 'string'
        ? containerNamespace(item.name, opening)
        : ''
    return [prefix, namespace(item.children, point, code, starts, depth + 1)]
      .filter(Boolean)
      .join('.')
  }
  return ''
}

function parsedMacro(
  keyword: Keyword,
  hover: unknown,
  code: string,
  starts: number[],
  symbols: unknown,
): ProofDeclaration | undefined {
  if (
    !hover ||
    typeof hover !== 'object' ||
    !('range' in hover) ||
    !range(hover.range)
  )
    return
  const { start, end } = hover.range
  if (start.line >= starts.length || end.line >= starts.length) return
  const from = starts[start.line] + start.character,
    to = starts[end.line] + end.character
  if (
    from > keyword.offset ||
    to <= keyword.offset + keyword.kind.length ||
    from > (starts[start.line + 1] ?? code.length + 1) - 1 ||
    to > (starts[end.line + 1] ?? code.length + 1) - 1
  )
    return
  const command = code.slice(from, to)
  if (
    declarationKeyword(command)?.offset !== keyword.offset - from ||
    !command.slice(keyword.offset + keyword.kind.length - from).trim()
  )
    return
  return {
    name: [namespace(symbols, keyword.position, code, starts), keyword.name]
      .filter(Boolean)
      .join('.'),
    kind: keyword.kind,
    headerLine: keyword.position.line + 1,
    ...(placeholderWarning(command) && { checkStatus: 'warning' as const }),
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  }
}

// Mathlib defines "lemma" as a command macro. Lean excludes these macros from
// documentSymbol, but a hover on the keyword returns its parsed command range.
// Source identifies candidate positions only. Never infer a proof's extent.
export class MacroProofDeclarations {
  private previous?: {
    session: object
    source: string
    ranges: Map<number, ProofDeclaration>
    boundaries: ProofDeclaration[]
  }

  async collect(
    source: string,
    code: string,
    session: object,
    symbols: unknown,
    known: ProofDeclaration[],
    hover: (position: Position) => Promise<unknown>,
    cancelled: () => boolean,
    publish: (declarations: ProofDeclaration[]) => void,
  ) {
    const starts = [0]
    for (let i = 0; i < source.length; i++)
      if (source[i] === '\n') starts.push(i + 1)
    const candidates = missingKeywords(code, source, starts, known)
    const previous = this.previous
    const ranges = new Map<number, ProofDeclaration>()
    const state = { session, source, ranges, boundaries: [...known] }
    this.previous = state
    if (!candidates.length) return
    let reusableBefore = -1
    if (previous?.session === session) {
      if (previous.source === source) reusableBefore = Infinity
      else {
        let prefix = 0
        while (
          prefix < source.length &&
          source[prefix] === previous.source[prefix]
        )
          prefix++
        // An unchanged following command proves that an edit cannot extend the
        // preceding proof. Even adding a trailing `where` rechecks its command.
        for (const item of previous.boundaries) {
          if (
            (starts[item.endLine - 1] ?? Infinity) + item.endColumn - 1 >
            prefix
          )
            continue
          reusableBefore = Math.max(
            reusableBefore,
            starts[item.startLine - 1] + item.startColumn - 1,
          )
        }
      }
    }
    const pending = candidates.filter((item) => {
      const retained = previous?.ranges.get(item.offset)
      if (
        !retained ||
        (starts[retained.endLine - 1] ?? Infinity) + retained.endColumn - 1 >
          reusableBefore ||
        previous?.session !== session
      )
        return true
      ranges.set(item.offset, retained)
      state.boundaries.push(retained)
      return false
    })
    const display = () =>
      publish(
        [...known, ...ranges.values()].sort(
          (a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn,
        ),
      )
    if (ranges.size) display()
    let index = 0
    const worker = async () => {
      while (!cancelled() && index < pending.length) {
        const keyword = pending[index++]
        const answer = await hover(keyword.position).catch(() => undefined)
        if (cancelled() || this.previous !== state) return
        const item = parsedMacro(keyword, answer, code, starts, symbols)
        if (item) {
          ranges.set(keyword.offset, item)
          state.boundaries.push(item)
          if (ranges.size % 16 === 0 && index < pending.length) display()
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, worker),
    )
    if (pending.length && !cancelled() && this.previous === state) display()
  }
}
