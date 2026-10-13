import { correctSourceUrl } from './library-sources.mjs'

const declarationKinds = new Set([
  'theorem',
  'lemma',
  'def',
  'abbrev',
  'opaque',
  'instance',
  'class',
  'structure',
  'inductive',
  'axiom',
  'constant',
  'example',
])
const declarationStart =
  /^[ \t]*(?:@\[[^\n]*?\][ \t]*)*(?:(?:private|protected|public|noncomputable|unsafe|partial|nonrec)\s+)*(theorem|lemma|def|abbrev|opaque|instance|class|structure|inductive|axiom|constant|example)(?![\p{L}\p{N}_'])/mu

function textField(values, limit = 16_000) {
  const value = values.find(
    (value) => typeof value === 'string' && value.trim(),
  )
  if (!value) return ''
  const trimmed = value.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n…` : trimmed
}

// Mask comments and literals while preserving source offsets. A source header
// is a signature, not Lean's inferred type; no Lean parser runs in this proxy.
function maskedSource(source) {
  let result = '',
    index = 0
  const append = (start, end) => {
    result += source.slice(start, end).replace(/[^\n\r]/g, ' ')
  }
  while (index < source.length) {
    const start = index
    if (source.startsWith('/-', index)) {
      let depth = 1
      index += 2
      while (index < source.length && depth) {
        if (source.startsWith('/-', index)) {
          depth++
          index += 2
        } else if (source.startsWith('-/', index)) {
          depth--
          index += 2
        } else index++
      }
      if (depth) return null
      append(start, index)
    } else if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end
      append(start, index)
    } else {
      const raw = /^r(#+)?"/.exec(source.slice(index))
      if (raw) {
        const terminator = '"' + (raw[1] || '')
        const end = source.indexOf(terminator, index + raw[0].length)
        if (end < 0) return null
        index = end + terminator.length
        append(start, index)
      } else if (source[index] === '"') {
        index++
        let closed = false
        while (index < source.length) {
          if (source[index] === '\\') index += 2
          else if (source[index++] === '"') {
            closed = true
            break
          }
        }
        if (!closed) return null
        append(start, index)
      } else if (source[index] === '«') {
        const end = source.indexOf('»', index + 1)
        if (end < 0) return null
        index = end + 1
        append(start, index)
      } else {
        const char =
          source[index] === "'" &&
          /^'(?:\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/u.exec(
            source.slice(index),
          )
        if (char) {
          index += char[0].length
          append(start, index)
        } else result += source[index++]
      }
    }
  }
  return result
}

function sourceSignature(source) {
  if (!source || source.length > 64_000) return null
  const masked = maskedSource(source)
  if (masked === null) return null
  const match = declarationStart.exec(masked)
  if (!match) return null
  const kind = match[1]
  let depth = 0,
    end = source.length
  for (
    let index = match.index + match[0].length;
    index < masked.length;
    index++
  ) {
    const char = masked[index]
    if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) {
      if (--depth < 0) return null
    } else if (depth === 0) {
      const wordStart = !/[\p{L}\p{N}_'.]/u.test(masked[index - 1] || '')
      if (
        masked.startsWith(':=', index) ||
        (wordStart && /^where(?![\p{L}\p{N}_'.])/u.test(masked.slice(index)))
      ) {
        end = index
        break
      }
      // Equation-style declarations omit :=. Distinguish actual arms from
      // ordinary notation such as a result type beginning with |x| ≥ 0.
      if (
        char === '|' &&
        !masked.slice(masked.lastIndexOf('\n', index) + 1, index).trim()
      ) {
        const lineEnd = masked.indexOf('\n', index)
        if (
          kind === 'inductive' ||
          masked
            .slice(index, lineEnd < 0 ? masked.length : lineEnd)
            .includes('=>')
        ) {
          end = index
          break
        }
      }
      if (masked.startsWith('=>', index)) return { kind, signature: '' }
      // Top-level let/match/fun expressions can contain their own := or where.
      // Leave their signature unavailable rather than guessing a body boundary.
      if (
        wordStart &&
        /^(?:let|have|fun|match|do|by)(?![\p{L}\p{N}_'.])/u.test(
          masked.slice(index),
        )
      )
        return { kind, signature: '' }
    }
  }
  if (depth !== 0) return { kind, signature: '' }
  return { kind, signature: textField([source.slice(match.index, end)]) }
}

function safeUrl(values) {
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 8_000) continue
    try {
      const url = new URL(value)
      if (
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        return url.href
    } catch {}
  }
  return null
}

function normalizeHit(hit) {
  const source = [hit.source_text, hit.declaration_text, hit.source_code].find(
    (value) => typeof value === 'string' && value.trim(),
  )
  const parsed = sourceSignature(source)
  const type = textField([hit.type])
  const suppliedSignature = textField([
    hit.signature,
    hit.statement,
    hit.formal_statement,
    hit.formalStatement,
  ])
  const signature = suppliedSignature || parsed?.signature || ''
  const rawKind = textField(
    [hit.kind, hit.declaration_kind, hit.declarationKind],
    100,
  ).toLowerCase()
  const normalizedKind = rawKind === 'definition' ? 'def' : rawKind
  const kind = declarationKinds.has(normalizedKind)
    ? normalizedKind
    : parsed?.kind || null
  return {
    name:
      textField(
        [
          hit.name,
          hit.declaration_name,
          hit.primary_declaration,
          hit.declarationName,
        ],
        2_000,
      ) || 'Unnamed declaration',
    type,
    signature,
    signatureSource: type
      ? 'type'
      : suppliedSignature
        ? 'signature'
        : parsed?.signature
          ? 'source'
          : null,
    kind,
    doc: textField([hit.doc, hit.docstring, hit.documentation], 8_000),
    module: textField(
      [hit.module, hit.module_name, hit.source_file, hit.file_path],
      2_000,
    ),
    url: correctSourceUrl(safeUrl([hit.url, hit.source_url, hit.source_link])),
  }
}

export async function searchDeclarations(
  { query, backend, projectId },
  owner,
  workspaces,
  {
    fetchImpl = fetch,
    leanExploreUrl = process.env.STUDIO_LEANEXPLORE_URL,
  } = {},
) {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000)
    throw Object.assign(
      new Error('Enter a search query of up to 2,000 characters.'),
      { status: 400 },
    )
  if (!['loogle', 'leanexplore'].includes(backend))
    throw Object.assign(new Error('Choose Loogle or LeanExplore.'), {
      status: 400,
    })
  const project = projectId ? workspaces.get(projectId, owner) : null
  const endpoint =
    backend === 'loogle'
      ? 'https://loogle.lean-lang.org/json'
      : leanExploreUrl || 'https://www.leanexplore.com/api/v2/search'
  const validEndpoint = safeUrl([endpoint])
  if (!validEndpoint)
    throw Object.assign(
      new Error(
        'The configured search endpoint must be an HTTP or HTTPS URL without credentials.',
      ),
      { status: 503 },
    )
  const url = new URL(validEndpoint)
  url.searchParams.set('q', query.trim())
  if (backend === 'leanexplore') url.searchParams.set('limit', '12')
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', 'user-agent': 'LeanFlowWeb/0.1' },
  })
  if (!response.ok)
    throw Object.assign(
      new Error(
        `${backend === 'loogle' ? 'Loogle' : 'LeanExplore'} is unavailable (HTTP ${response.status}). Try again later or use the other search service.`,
      ),
      { status: 502 },
    )
  const text = await response.text()
  if (text.length > 2_000_000)
    throw new Error('Search response exceeded the size limit.')
  const data = JSON.parse(text)
  if (data.error)
    throw Object.assign(
      new Error(
        typeof data.error === 'string'
          ? data.error
          : JSON.stringify(data.error),
      ),
      { status: 400 },
    )
  const rawHits = data.hits || data.results || []
  if (!Array.isArray(rawHits))
    throw Object.assign(
      new Error(
        'The search service returned an unexpected response. Try again later.',
      ),
      { status: 502 },
    )
  const hits = rawHits
    .filter((hit) => hit && typeof hit === 'object' && !Array.isArray(hit))
    .slice(0, 30)
  return {
    query,
    backend,
    count: data.count ?? hits.length,
    source: {
      name: backend === 'loogle' ? 'Loogle' : 'LeanExplore',
      url: endpoint,
      version:
        backend === 'leanexplore' && leanExploreUrl
          ? 'Configured index'
          : 'Hosted index',
      workspaceToolchain: project?.toolchain || null,
    },
    results: hits.map(normalizeHit),
  }
}
