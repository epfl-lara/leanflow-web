import type { ProofDeclaration } from './proofTarget'

interface Position {
  line: number
  character: number
}

interface Problem {
  start: Position
  end: Position
  severity: 'error' | 'warning'
}

interface CheckedDocument {
  session: object
  version: number
  problems: Problem[]
  hasDiagnostics: boolean
  progressDone: boolean
  confirmed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown) {
  return isRecord(value) ? value : undefined
}

function position(value: unknown): Position | undefined {
  const point = record(value)
  if (
    typeof point?.line === 'number' &&
    Number.isSafeInteger(point.line) &&
    point.line >= 0 &&
    typeof point.character === 'number' &&
    Number.isSafeInteger(point.character) &&
    point.character >= 0
  )
    return { line: point.line, character: point.character }
}

function compare(a: Position, b: Position) {
  return a.line - b.line || a.character - b.character
}

function readProblems(entries: unknown[]): Problem[] | undefined {
  const result: Problem[] = []
  for (const entry of entries) {
    const diagnostic = record(entry)
    if (diagnostic?.severity === 3 || diagnostic?.severity === 4) continue
    const range = record(diagnostic?.fullRange ?? diagnostic?.range)
    const start = position(range?.start),
      end = position(range?.end)
    if (!start || !end || compare(start, end) > 0) return
    result.push({
      start,
      end,
      severity: diagnostic?.severity === 2 ? 'warning' : 'error',
    })
  }
  return result
}

// Keep the compiler's versioned snapshots before vscode-languageclient converts
// them into editor markers (which discard both the version and incremental flag).
// Only open documents on this runtime's current connection retain diagnostics.
export class ProofDiagnostics {
  private documents = new Map<string, CheckedDocument>()
  private generation = 0
  private listeners = new Set<(uri?: string) => void>()

  hasOpenDocument(uri: string) {
    return this.documents.has(uri)
  }

  subscribe(listener: (uri?: string) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(uri?: string) {
    for (const listener of this.listeners) listener(uri)
  }

  reset() {
    this.generation++
    this.documents.clear()
    this.changed()
  }

  openConnection(onDidOpen?: (uri: string) => void) {
    this.reset()
    const generation = this.generation
    return {
      sent: (method: string, params: unknown) => {
        if (generation !== this.generation) return
        const doc = record(record(params)?.textDocument)
        if (typeof doc?.uri !== 'string') return
        if (method === 'textDocument/didClose') this.documents.delete(doc.uri)
        else if (
          method === 'textDocument/didOpen' ||
          method === 'textDocument/didChange'
        ) {
          if (
            typeof doc.version !== 'number' ||
            !Number.isSafeInteger(doc.version)
          )
            return
          this.documents.set(doc.uri, {
            session:
              method === 'textDocument/didChange'
                ? (this.documents.get(doc.uri)?.session ?? {})
                : {},
            version: doc.version,
            problems: [],
            hasDiagnostics: false,
            progressDone: false,
            confirmed: false,
          })
        } else return
        if (method === 'textDocument/didOpen') onDidOpen?.(doc.uri)
        this.changed(doc.uri)
      },
      received: (method: string, params: unknown) => {
        if (generation !== this.generation) return
        const data = record(params)
        const diagnostic = method === 'textDocument/publishDiagnostics'
        const doc = diagnostic ? data : record(data?.textDocument)
        if (typeof doc?.uri !== 'string' || !data) return
        const current = this.document(doc.uri, doc.version)
        if (!current) return
        if (diagnostic) {
          const problems = Array.isArray(data.diagnostics)
            ? readProblems(data.diagnostics)
            : undefined
          if (
            !problems ||
            (data.isIncremental !== undefined &&
              typeof data.isIncremental !== 'boolean')
          ) {
            current.hasDiagnostics = false
            current.problems = []
          } else if (data.isIncremental === true) {
            if (current.hasDiagnostics && problems.length)
              current.problems = current.problems.concat(problems)
          } else {
            current.hasDiagnostics = true
            current.problems = problems
          }
        } else if (method === '$/lean/fileProgress') {
          // A fatal or unfinished file cannot certify the remaining theorems.
          const done =
            Array.isArray(data.processing) && data.processing.length === 0
          if (!done && current.confirmed) {
            // A restarted worker can process the same version again. Give the
            // new run its own completion acknowledgement and diagnostic baseline.
            this.documents.set(doc.uri, {
              session: {},
              version: current.version,
              problems: [],
              hasDiagnostics: false,
              progressDone: false,
              confirmed: false,
            })
          } else current.progressDone = done
        } else return
        this.changed(doc.uri)
      },
      closed: () => {
        if (generation === this.generation) this.reset()
      },
    }
  }

  document(uri: string, version: unknown) {
    const current = this.documents.get(uri)
    if (current && current.version === version) return current
  }

  confirm(uri: string, doc: CheckedDocument) {
    if (
      this.documents.get(uri) !== doc ||
      !doc.hasDiagnostics ||
      !doc.progressDone
    )
      return
    doc.confirmed = true
    this.changed(uri)
  }
}

export function proofCheckStatuses(
  declarations: ProofDeclaration[],
  doc?: CheckedDocument,
): ProofDeclaration[] {
  const problems = (doc?.problems ?? [])
    .slice()
    .sort((a, b) => compare(a.start, b.start))
  const attributed = new Set<Problem>()
  let first = 0
  const results = declarations.map((declaration) => {
    if (
      declaration.kind !== 'theorem' &&
      declaration.kind !== 'lemma' &&
      declaration.kind !== 'example'
    )
      return declaration
    const start = {
      line: declaration.startLine - 1,
      character: declaration.startColumn - 1,
    }
    const end = {
      line: declaration.endLine - 1,
      character: declaration.endColumn - 1,
    }
    let checkStatus: ProofDeclaration['checkStatus'] =
      doc?.hasDiagnostics && doc.confirmed && doc.progressDone
        ? (declaration.checkStatus ?? 'checked')
        : 'pending'
    while (first < problems.length && compare(problems[first].end, start) < 0)
      first++
    for (
      let i = first;
      i < problems.length && compare(problems[i].start, end) <= 0;
      i++
    ) {
      const problem = problems[i]
      const point = compare(problem.start, problem.end) === 0
      // Lean can report a missing tactic at the insertion point just after the
      // command. Match a zero-width diagnostic there, as well as its interior.
      if (
        !point &&
        (compare(problem.start, end) >= 0 || compare(problem.end, start) <= 0)
      )
        continue
      if (point && compare(problem.start, start) < 0) continue
      attributed.add(problem)
      if (checkStatus !== 'error') checkStatus = problem.severity
    }
    return { ...declaration, checkStatus }
  })
  // An error in an import, command or enclosing section can prevent Lean from
  // checking subsequent declarations, even if their ranges have no diagnostics.
  const globalError = problems.find(
    (problem) => problem.severity === 'error' && !attributed.has(problem),
  )
  if (globalError)
    for (const item of results)
      if (
        item.checkStatus === 'checked' &&
        compare(globalError.start, {
          line: item.endLine - 1,
          character: item.endColumn - 1,
        }) <= 0
      )
        item.checkStatus = 'pending'
  return results
}
