import { createHash } from 'node:crypto'
import { isPdfFile } from '../shared/file-previews.mjs'
import {
  declarationKeyword,
  outlineCode,
} from '../shared/lean-outline-code.mjs'
import { isTexFile, TEX_SOURCE_MAX_BYTES } from '../shared/tex.mjs'
import { PAPER_LINKS_FILE } from '../shared/paper-links.mjs'
import { validateWorkspaceFilePath } from './workspace-paths.mjs'
import { informalizationTexPassages } from './informalization-document.mjs'

export { PAPER_LINKS_FILE }
const MAX_LINKS = 200
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_DECLARATION_LENGTH = 300
const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const record = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const onlyKeys = (value, keys) =>
  Object.keys(value).every((key) => keys.includes(key))
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const revision = (value) =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isLeanFile = (path) => path.endsWith('.lean')
const plainText = (value, maxLength) =>
  typeof value === 'string' &&
  value.length <= maxLength &&
  !!value.trim() &&
  !/[^\P{Cc}\t\n\r]/u.test(value)
const linesOf = (content) => content.replace(/\r\n?/g, '\n').split('\n')
const namePart = '(?:«[^«»\\r\\n]+»|[\\p{L}_][\\p{L}\\p{M}\\p{N}_\\x27!?]*)'
const leanName = namePart + '(?:\\.' + namePart + ')*'
const exactName = new RegExp('^' + leanName + '$', 'u')
const singleName = new RegExp('^' + namePart + '$', 'u')
const leadingName = new RegExp('^(' + leanName + ')(?=$|[\\s:{(\\[])', 'u')
const namespaceCommand = new RegExp(
  '^namespace\\s+(' + leanName + ')\\s*$',
  'u',
)

function projectFile(path) {
  const relative = validateWorkspaceFilePath(path)
  if (relative.startsWith('.lake/'))
    fail('Choose an editable project file for the paper link.')
  return relative
}

function normalize(input) {
  if (
    !record(input) ||
    !record(input.source) ||
    !record(input.target) ||
    !onlyKeys(input, ['source', 'target']) ||
    !onlyKeys(input.source, ['path', 'page', 'quote', 'line', 'label']) ||
    !onlyKeys(input.target, ['path', 'line', 'declaration'])
  )
    fail('Provide a paper passage and a named Lean declaration.')
  const path = projectFile(input.source.path)
  const { page, quote, line, label } = input.source
  let source
  if (isPdfFile(path)) {
    if (
      !positiveInteger(page) ||
      line !== undefined ||
      label !== undefined ||
      (quote !== undefined && !plainText(quote, 1000))
    )
      fail(
        'Choose a PDF page starting at 1 and an optional quote of up to 1,000 characters.',
      )
    source = {
      path,
      page,
      ...(quote === undefined ? {} : { quote: quote.trim() }),
    }
  } else if (isTexFile(path)) {
    if (
      !positiveInteger(line) ||
      page !== undefined ||
      quote !== undefined ||
      (label !== undefined &&
        (!plainText(label, 250) || /[\s{}\\%]/u.test(label)))
    )
      fail('Choose a TeX line starting at 1 and an optional LaTeX label.')
    source = { path, line, ...(label === undefined ? {} : { label }) }
  } else fail('Choose a .pdf or .tex file for the paper passage.')
  const target = {
    path: projectFile(input.target.path),
    line: input.target.line,
    declaration: input.target.declaration,
  }
  if (
    !isLeanFile(target.path) ||
    !positiveInteger(target.line) ||
    !plainText(target.declaration, MAX_DECLARATION_LENGTH) ||
    !exactName.test(target.declaration)
  )
    fail(
      'Choose a .lean file, declaration line starting at 1, and exact declaration name.',
    )
  return { source, target }
}

function linkId({ source, target }) {
  return sha256(
    JSON.stringify([
      source.path,
      'page' in source ? source.page : (source.label ?? source.line),
      target.path,
      target.declaration,
    ]),
  )
}

function parseManifest(content, strict = false) {
  if (content === undefined || content === null) return []
  const invalid = () =>
    fail(
      'Repair or remove the invalid leanflow.paper-links.json file and try again.',
    )
  if (
    typeof content !== 'string' ||
    Buffer.byteLength(content) > MAX_MANIFEST_BYTES
  )
    invalid()
  let file
  try {
    file = JSON.parse(content)
  } catch {
    invalid()
  }
  if (
    file?.version !== 1 ||
    !Array.isArray(file.links) ||
    file.links.length > MAX_LINKS ||
    (strict && !onlyKeys(file, ['version', 'links']))
  )
    invalid()
  const ids = new Set()
  return file.links.map((entry) => {
    if (
      !record(entry) ||
      (strict &&
        !onlyKeys(entry, [
          'id',
          'source',
          'target',
          'sourceRevision',
          'targetRevision',
        ]))
    )
      invalid()
    const link = normalize({ source: entry.source, target: entry.target })
    const id = linkId(link)
    if (
      entry.id !== id ||
      ids.has(id) ||
      !revision(entry.sourceRevision) ||
      !revision(entry.targetRevision)
    )
      invalid()
    ids.add(id)
    return {
      id,
      ...link,
      sourceRevision: entry.sourceRevision,
      targetRevision: entry.targetRevision,
    }
  })
}

function labelLines(lines, labels) {
  const matches = new Map()
  if (!labels.size) return matches
  for (const [index, line] of lines.entries()) {
    if (!line.includes('\\label')) continue
    const code = withoutTexComment(line)
    for (const match of code.matchAll(/(?<!\\)\\label\s*\{([^{}]+)\}/gu)) {
      const label = match[1].trim()
      if (labels.has(label))
        matches.set(label, matches.has(label) ? null : index + 1)
    }
  }
  return matches
}

function withoutTexComment(line) {
  return line.replace(/(^|[^\\])((?:\\\\)*)%.*$/u, '$1$2')
}

// A standalone label often emits no PDF box. Use the surrounding environment
// when it is short and explicitly closed, so its printed lines can carry the link.
function labeledTexEnvironments(lines, labelLines) {
  const ranges = new Map()
  const stack = []
  for (const [index, line] of lines.entries()) {
    if (!line.includes('\\begin') && !line.includes('\\end')) continue
    const number = index + 1
    for (const match of withoutTexComment(line).matchAll(
      /(?<!\\)\\(begin|end)\s*\{([^{}\s]+)\}/gu,
    )) {
      const [, kind, name] = match
      if (kind === 'begin') {
        stack.push({ name, startLine: number })
        continue
      }
      if (stack.at(-1)?.name !== name) continue
      const { startLine } = stack.pop()
      if (name === 'document' || number - startLine > 80) continue
      for (const anchor of labelLines) {
        if (anchor >= startLine && anchor <= number && !ranges.has(anchor))
          ranges.set(anchor, { startLine, endLine: number })
      }
    }
  }
  return ranges
}

function texLine(lines, labels, { line, label }, expectedRevision) {
  if (label !== undefined) return labels.get(label) ?? null
  if (lines[line - 1] === undefined || !lines[line - 1].trim()) return null
  return !expectedRevision || sha256(lines[line - 1]) === expectedRevision
    ? line
    : null
}

function inlineProofStart(code) {
  let depth = 0
  let quoted = false
  for (let index = 0; index < code.length; index++) {
    const character = code[index]
    if (character === '«') quoted = true
    else if (character === '»') quoted = false
    else if (quoted) continue
    else if ('([{⦃'.includes(character)) depth++
    else if (')]}⦄'.includes(character)) depth--
    else if (depth === 0 && character === ':' && code[index + 1] === '=') {
      // An unparenthesized term in the type can have its own assignment.
      if (/\b(?:let|match|do|calc|by)\b/u.test(code.slice(0, index))) return -1
      return index
    }
  }
  return -1
}

// The lexer checks source spelling and ordinary namespaces. These anchors
// identify navigation locations and carry no Lean proof-verification result.
function declarationsIn(content, wantedNames, commandLines) {
  const normalized = content.replace(/\r\n?/g, '\n')
  const original = normalized.split('\n')
  const code = outlineCode(normalized, {
    keepQuotedIdentifiers: true,
  }).split('\n')
  const scopes = ['']
  const declarations = []
  const counts = new Map()
  for (let index = 0; index < code.length; index++) {
    const command = code[index].trim()
    const namespace = namespaceCommand.exec(command)?.[1]
    const prefix = scopes.at(-1)
    if (namespace) {
      commandLines?.push(index + 1)
      scopes.push(
        prefix === null ||
          prefix.length + namespace.length >= MAX_DECLARATION_LENGTH
          ? null
          : prefix + namespace + '.',
      )
      continue
    }
    if (
      /^(?:(?:noncomputable|public|meta)\s+)?section(?:\s|$)|^mutual$/u.test(
        command,
      )
    ) {
      commandLines?.push(index + 1)
      scopes.push(prefix)
      continue
    }
    if (/^end(?:\s|$)/u.test(command)) {
      commandLines?.push(index + 1)
      if (scopes.length > 1) scopes.pop()
      continue
    }
    const keyword = declarationKeyword(code[index])
    if (
      commandLines &&
      (keyword ||
        /^(?:#|(?:attribute|axiom|import|open|set_option|variable|universe)\b)/u.test(
          code[index],
        ))
    )
      commandLines.push(index + 1)
    if (!keyword || keyword.kind === 'example') continue
    let nameIndex = index
    let tail = code[index]
      .slice(keyword.offset + keyword.kind.length)
      .trimStart()
    while (!tail && nameIndex + 1 < code.length)
      tail = code[++nameIndex].trimStart()
    const localName = leadingName.exec(tail)?.[1]
    if (!localName) continue
    const name = localName.startsWith('_root_.')
      ? localName.slice('_root_.'.length)
      : prefix === null
        ? null
        : prefix + localName
    if (
      !name ||
      name.length > MAX_DECLARATION_LENGTH ||
      (wantedNames && !(wantedNames.has(name) || wantedNames.has(localName)))
    )
      continue
    const count = counts.get(name) || 0
    if (count >= 2) continue
    counts.set(name, count + 1)
    const header = original.slice(index, nameIndex + 1)
    const legacyRevision = sha256(header.join('\n').trim())
    const proofStart = inlineProofStart(code[nameIndex])
    if (proofStart >= 0)
      header[header.length - 1] = header.at(-1).slice(0, proofStart)
    declarations.push({
      name,
      localName,
      line: index + 1,
      nameLine: nameIndex + 1,
      revision:
        proofStart < 0 ? legacyRevision : sha256(header.join('\n').trim()),
      legacyRevision,
    })
  }
  return declarations
}

function declarationSources(source) {
  const lines = linesOf(source)
  const commandLines = []
  const entries = declarationsIn(source, undefined, commandLines)
  const result = new Map()
  let command = 0
  for (const { name, line, nameLine } of entries) {
    while (commandLines[command] <= nameLine) command++
    const end = commandLines[command] ?? lines.length + 1
    const content = lines
      .slice(line - 1, end - 1)
      .join('\n')
      .trimEnd()
    result.set(name, result.has(name) ? null : { line, content })
  }
  return result
}

// Including each body catches proofs that replace an existing placeholder.
export function changedPaperDeclarations(changes, signal) {
  const targets = []
  for (const { path, before, after } of changes) {
    signal?.throwIfAborted()
    if (
      typeof after !== 'string' ||
      !isLeanFile(path) ||
      path.split('/').at(-1) === 'lakefile.lean'
    )
      continue
    const previous = declarationSources(before || '')
    for (const [declaration, entry] of declarationSources(after)) {
      if (entry && entry.content !== previous.get(declaration)?.content)
        targets.push({ path, line: entry.line, declaration })
      if (targets.length >= 40) return targets
    }
  }
  return targets
}

export async function makePaperLink(input, { readText, readPdf, signal }) {
  const { source, target } = normalize(input)
  let sourceRevision
  signal?.throwIfAborted()
  if ('page' in source) {
    const { content, pageCount } = await readPdf(source.path)
    if (positiveInteger(pageCount) && source.page > pageCount)
      fail('That PDF page does not exist. Check the page number and try again.')
    sourceRevision = sha256(content)
  } else {
    const { content } = await readText(source.path)
    const lines = linesOf(content)
    const labels = labelLines(
      lines,
      new Set(source.label ? [source.label] : []),
    )
    if (texLine(lines, labels, source) !== source.line)
      fail(
        'The TeX anchor does not match that line. Check the saved line and label.',
      )
    sourceRevision = sha256(lines[source.line - 1])
  }
  signal?.throwIfAborted()
  const { content } = await readText(target.path)
  const canonicalName = target.declaration.replace(/^_root_\./u, '')
  const allowLocalName = singleName.test(target.declaration)
  const declarations = declarationsIn(content, new Set([canonicalName]))
  const declaration = declarations.find(
    (item) =>
      (item.name === canonicalName ||
        (allowLocalName && item.localName === canonicalName)) &&
      (item.line === target.line || item.nameLine === target.line),
  )
  if (
    !declaration ||
    declarations.filter(({ name }) => name === declaration.name).length !== 1
  )
    fail(
      'The Lean declaration does not match that line. Use the exact name at its declaration header.',
    )
  signal?.throwIfAborted()
  target.line = declaration.line
  target.declaration = declaration.name
  const link = { source, target }
  return {
    id: linkId(link),
    ...link,
    sourceRevision,
    targetRevision: declaration.revision,
  }
}

export function upsertPaperLink(content, link) {
  const links = parseManifest(content)
  const index = links.findIndex(({ id }) => id === link.id)
  if (index >= 0) links[index] = link
  else links.push(link)
  return writeManifest(links)
}

function writeManifest(links) {
  if (links.length > MAX_LINKS)
    fail(
      'This project has 200 paper links. Remove an old link before adding another.',
      413,
    )
  const next = JSON.stringify({ version: 1, links }, null, 2) + '\n'
  if (Buffer.byteLength(next) > MAX_MANIFEST_BYTES)
    fail(
      'The paper links file is too large. Shorten quotes or remove links and try again.',
      413,
    )
  return next
}

export function mergePaperLinkChanges({ baseline, before, after, current }) {
  const entries = (text) =>
    new Map(parseManifest(text, true).map((link) => [link.id, link]))
  let base, previous, proposed, saved
  try {
    base = entries(baseline)
    previous = entries(before)
    proposed = entries(after)
    saved = entries(current)
  } catch (error) {
    // Manually edited or unknown manifest formats keep ordinary file conflicts.
    if (error.status === 400) return undefined
    throw error
  }
  const equal = (first, second) =>
    JSON.stringify(first) === JSON.stringify(second)
  const touched = [
    ...new Set([...base.keys(), ...previous.keys(), ...proposed.keys()]),
  ].filter(
    (id) =>
      !equal(base.get(id), previous.get(id)) ||
      !equal(base.get(id), proposed.get(id)),
  )
  if (!touched.length) return undefined
  let changed = false
  for (const id of touched) {
    const expected = previous.get(id)
    if (!equal(expected, saved.get(id)))
      fail(
        'A paper link changed during the assistant run. Retry from the current project.',
        409,
      )
    const link = proposed.get(id)
    if (equal(expected, link)) continue
    changed = true
    if (link) saved.set(id, link)
    else saved.delete(id)
  }
  if (!changed) return current
  return current === before || (!saved.size && after === null)
    ? after
    : writeManifest([...saved.values()])
}

async function readAnchor(cache, path, read) {
  if (!cache.has(path)) {
    try {
      cache.set(path, await read(path))
    } catch (error) {
      if (![400, 403, 404, 409, 413, 415].includes(error.status)) throw error
      cache.set(path, null)
    }
  }
  return cache.get(path)
}

function currentTexLines(content, anchors, includeRenderRanges) {
  if (!anchors.length) return new Map()
  const lines = linesOf(content)
  const labels = labelLines(
    lines,
    new Set(
      anchors.flatMap(({ source }) => (source.label ? [source.label] : [])),
    ),
  )
  const labeledLines = new Set([...labels.values()].filter(Boolean))
  const ranges =
    includeRenderRanges && labeledLines.size
      ? labeledTexEnvironments(lines, labeledLines)
      : new Map()
  const resolved = new Map(
    anchors.map(({ id, source, sourceRevision }) => {
      const line = texLine(lines, labels, source, sourceRevision)
      return [
        id,
        { line, renderRange: source.label ? ranges.get(line) : undefined },
      ]
    }),
  )
  // Keep an unlabeled line linked when inserting the source reference or a
  // paragraph ahead of it. A moved line must still match its saved bytes
  // uniquely; editing or duplicating it requires updating the original link.
  const missing = anchors.filter(
    ({ id, source }) => !source.label && !resolved.get(id).line,
  )
  if (missing.length) {
    const revisions = new Set(missing.map((link) => link.sourceRevision))
    const locations = new Map()
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      const revision = sha256(line)
      if (revisions.has(revision))
        locations.set(revision, locations.has(revision) ? null : index + 1)
    }
    for (const { id, sourceRevision } of missing)
      resolved.get(id).line = locations.get(sourceRevision) ?? null
  }
  return resolved
}

function markedTexLinks(content, path, limit) {
  const links = []
  for (const { key, line, startLine, endLine } of informalizationTexPassages(
    content,
  )) {
    if (links.length >= limit) break
    const ref = /^(.+?\.lean)#(.+)$/.exec(key)
    if (
      !ref ||
      ref[2].length > MAX_DECLARATION_LENGTH ||
      !exactName.test(ref[2])
    )
      continue
    let targetPath
    try {
      targetPath = projectFile(ref[1])
    } catch (error) {
      if (error.status === 400) continue
      throw error
    }
    const source = { path, line }
    const target = {
      path: targetPath,
      declaration: ref[2].replace(/^_root_\./u, ''),
    }
    links.push({
      id: linkId({ source, target }),
      source,
      target,
      renderRange: { startLine, endLine },
    })
  }
  return links
}

async function resolveTexPassages(
  links,
  papers,
  readText,
  includeRanges,
  signal,
) {
  const sources = new Map()
  const marked = []
  const texAnchors = Map.groupBy(
    links.filter(({ source }) => 'line' in source),
    ({ source }) => source.path,
  )
  let bytes = 0
  for (const file of new Set([...texAnchors.keys(), ...papers])) {
    signal?.throwIfAborted()
    if (
      !texAnchors.has(file) &&
      (bytes >= TEX_SOURCE_MAX_BYTES || marked.length >= MAX_LINKS)
    )
      break
    await readAnchor(sources, file, async (filename) => {
      const { content } = await readText(filename)
      const anchors = currentTexLines(
        content,
        texAnchors.get(file) || [],
        includeRanges,
      )
      if (papers.has(file)) {
        bytes += Buffer.byteLength(content)
        if (marked.length >= MAX_LINKS || bytes > TEX_SOURCE_MAX_BYTES)
          return anchors
        for (const candidate of markedTexLinks(
          content,
          file,
          MAX_LINKS - marked.length,
        )) {
          // A formalization may already have recorded this theorem. Keep that
          // reviewed link and use the printed range supplied by the marker.
          const existing = texAnchors.get(file)?.find(({ id, target }) => {
            const line = anchors.get(id).line
            return (
              id === candidate.id ||
              (target.path === candidate.target.path &&
                target.declaration === candidate.target.declaration &&
                line >= candidate.renderRange.startLine &&
                line <= candidate.renderRange.endLine)
            )
          })
          if (existing) {
            const anchor = anchors.get(existing.id)
            anchor.line ??= candidate.source.line
            anchor.renderRange ??= candidate.renderRange
          } else {
            anchors.set(candidate.id, {
              line: candidate.source.line,
              renderRange: candidate.renderRange,
            })
            marked.push(candidate)
          }
        }
      }
      return anchors
    })
  }
  return { sources, marked }
}

export async function listPaperLinks(
  content,
  { path, sourcePaths, readText, readPdf, signal },
) {
  const selected = path === undefined ? undefined : projectFile(path)
  const stored = parseManifest(content).filter(({ source, target }) =>
    sourcePaths
      ? sourcePaths.has(source.path)
      : selected === undefined ||
        source.path === selected ||
        target.path === selected,
  )
  const papers =
    sourcePaths ?? (isTexFile(selected) ? new Set([selected]) : new Set())
  const { sources, marked } = await resolveTexPassages(
    stored,
    papers,
    readText,
    !!sourcePaths,
    signal,
  )
  const links = [...stored, ...marked]
  const pdfCache = new Map()
  const targetCache = new Map()
  const names = new Map()
  for (const { target } of links) {
    if (!names.has(target.path)) names.set(target.path, new Set())
    names.get(target.path).add(target.declaration)
  }
  const result = []
  for (const { id, source, target, sourceRevision, targetRevision } of links) {
    signal?.throwIfAborted()
    const anchor = sources.get(source.path)?.get(id)
    const sourceLine = anchor?.line
    const sourceCurrent =
      'page' in source
        ? (await readAnchor(pdfCache, source.path, async (filename) =>
            sha256((await readPdf(filename)).content),
          )) === sourceRevision
        : !!sourceLine
    const candidates = await readAnchor(
      targetCache,
      target.path,
      async (filename) =>
        declarationsIn((await readText(filename)).content, names.get(filename)),
    )
    const matching = (candidates || []).filter(
      (declaration) => declaration.name === target.declaration,
    )
    const destination =
      matching.length === 1 &&
      (!targetRevision ||
        matching[0].revision === targetRevision ||
        matching[0].legacyRevision === targetRevision)
        ? matching[0]
        : null
    // A comment supplies a name rather than a saved destination line. Only
    // expose its link when that name resolves uniquely in the referenced file.
    if (!targetRevision && !destination) continue
    result.push({
      id,
      source: sourceLine ? { ...source, line: sourceLine } : source,
      target: destination ? { ...target, line: destination.line } : target,
      status: sourceCurrent && destination ? 'current' : 'stale',
      ...(anchor?.renderRange ? { renderRange: anchor.renderRange } : {}),
    })
  }
  signal?.throwIfAborted()
  return result
}

async function readProjectPaperLinks(
  workspaces,
  projectId,
  actor,
  selection,
  signal,
) {
  const readText = (filename) => workspaces.readFile(projectId, actor, filename)
  let manifest
  try {
    manifest = (await readText(PAPER_LINKS_FILE)).content
  } catch (error) {
    if (error.status !== 404) throw error
  }
  const links = await listPaperLinks(manifest, {
    ...selection,
    readText,
    readPdf: (filename) =>
      workspaces.readPdfPreview(projectId, actor, filename, { signal }),
    signal,
  })
  workspaces.accessibleProject(projectId, actor)
  return links
}

export async function projectPaperLinks(
  workspaces,
  projectId,
  actor,
  path,
  { signal } = {},
) {
  workspaces.accessibleProject(projectId, actor)
  const selected = projectFile(path)
  if (!isPdfFile(selected) && !isTexFile(selected) && !isLeanFile(selected))
    return { links: [] }
  const links = await readProjectPaperLinks(
    workspaces,
    projectId,
    actor,
    { path: selected },
    signal,
  )
  return { links }
}

export async function projectTexPaperLinks(
  workspaces,
  projectId,
  actor,
  paths,
  { signal } = {},
) {
  workspaces.accessibleProject(projectId, actor)
  const sourcePaths = new Set(paths.filter(isTexFile))
  if (!sourcePaths.size) return []
  const links = await readProjectPaperLinks(
    workspaces,
    projectId,
    actor,
    { sourcePaths },
    signal,
  )
  return links.filter(({ status }) => status === 'current')
}
