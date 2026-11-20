import path from 'node:path'
import { isTexFile, safeTexPath } from '../shared/tex.mjs'
import { fail, relativeFile } from './workspace-paths.mjs'

const isDocument = (file) =>
  typeof file === 'string' && /\.(?:tex|md|markdown)$/i.test(file)

export function validateInformalizationOutputPath(file) {
  const name = relativeFile(file, { write: true })
  if (!isDocument(name))
    fail('Choose a .tex or .md document for the informalization.')
  if (name.split('/').some((part) => part.startsWith('.')))
    fail('Choose a visible project document for the informalization.')
  return name
}

// Recognize quoted names, ordinary project paths, and a filename with spaces
// following a directory. A unique filename can be named in any language.
const documentMentions =
  /`([^`\n]+?\.(?:tex|md|markdown))`|"([^"\n]+?\.(?:tex|md|markdown))"|'([^'\n]+?\.(?:tex|md|markdown))'|(?<![\p{L}\p{N}_./-])(\/?(?:[\p{L}\p{N}_.-]+\/)+(?:[\p{L}\p{N}_.-]+ )*?[\p{L}\p{N}_.-]+\.(?:tex|md|markdown)|\/?[\p{L}\p{N}_.-]+\.(?:tex|md|markdown))(?![\p{L}\p{N}_/-])/giu

function mentionedDocuments(text, snapshot) {
  const mentions = []
  for (const match of (text || '').matchAll(documentMentions)) {
    let name = match.slice(1).find(Boolean)
    let start = match.index
    const end = start + match[0].length
    if (name === match[0] && !name.includes('/')) {
      const prefix = text.slice(0, end)
      const existing = snapshot.files
        .map(({ path: file }) => path.posix.basename(file))
        .filter((file) => file.endsWith(' ' + name) && prefix.endsWith(file))
        .sort((a, b) => b.length - a.length)[0]
      if (existing) {
        start = end - existing.length
        name = existing
      }
    }
    const before = text.slice(0, start).trimEnd()
    const after = text.slice(end)
    if (
      /\b(?:from|based on|according to|see|read|found in|definition in|notation in|notation from|refer to|consult|reference|example|template|style of|source|like)(?:\s+(?:the|a|file|document|in))*$/i.test(
        before,
      ) ||
      /\b(?:do\s+not|don't|never|avoid|not)\b[^,;.!?\n]*$/i.test(before) ||
      /^\s+(?:as (?:a |the )?(?:source|reference|example|template|guide)|for (?:context|reference)|to (?:guide|check|verify|look))\b/i.test(
        after,
      )
    )
      continue
    const exact = snapshot.files.some(({ path }) => path === name)
    const choices =
      !exact && !name.includes('/')
        ? snapshot.files.filter(
            ({ path: file }) => path.posix.basename(file) === name,
          )
        : []
    const file = choices.length > 1 ? null : (choices[0]?.path ?? name)
    const directive =
      /\b(?:in(?:to)?|inside|to|as|update|edit|create|use|target|named|called|(?:destination|output(?:\s+(?:file|document))?)(?:\s+is|\s*[:=])?)(?:\s+(?:the|a|new|file|document))*$/i.test(
        before,
      )
    mentions.push({ file, format: formatOf(name), directive })
  }
  return mentions
}

function requestedOutput(text, snapshot) {
  const mentions = mentionedDocuments(text, snapshot)
  const explicit = mentions.filter(({ directive }) => directive)
  const alternatives = /\b(?:either|or|choose between)\b/i.test(text || '')
  const named = explicit.length && !alternatives ? explicit : mentions
  const names = new Set(named.map(({ file }) => file))
  const only = names.size === 1 && names.values().next().value
  const exact = only ? validateInformalizationOutputPath(only) : undefined
  return { exact, formats: [...new Set(mentions.map(({ format }) => format))] }
}

export function followupInformalizationOutput(text, snapshot) {
  return requestedOutput(text, snapshot).exact
}

const formatOf = (file) => (isTexFile(file) ? 'tex' : 'md')
const formatRequest = (text) => {
  const formats = [
    ...(text || '').matchAll(
      /(?<![\p{L}\p{N}./_-])(?:\.?(markdown|md|tex)|latex)\b/giu,
    ),
  ].map(([word]) => (/^(?:\.)?(?:md|markdown)$/i.test(word) ? 'md' : 'tex'))
  return new Set(formats).size === 1 ? formats[0] : undefined
}

function outputRequest(job, snapshot, followups = []) {
  const prompt = job.prompt || ''
  const initial =
    job.outputFile === undefined ? requestedOutput(prompt, snapshot) : {}
  let exact =
    job.outputFile === undefined
      ? initial.exact
      : validateInformalizationOutputPath(job.outputFile)
  let format = exact ? formatOf(exact) : formatRequest(prompt)
  let fresh =
    /\b(?:new|fresh|separate|standalone)\s+(?:(?:latex|tex|markdown)\s+)?(?:document|file|paper)\b/i.test(
      prompt,
    )
  for (const { status, text } of followups) {
    if (status !== 'accepted') continue
    const redirected = followupInformalizationOutput(text, snapshot)
    const requested = redirected ? formatOf(redirected) : formatRequest(text)
    if (redirected) exact = redirected
    else if (requested && exact && formatOf(exact) !== requested) {
      exact = undefined
      fresh = true
    }
    if (requested) format = requested
  }
  const context = [
    ...(job.files || []).filter((file) => file !== job.currentFile),
    job.currentFile,
    job.previousDocument,
  ].filter(
    (file) =>
      isDocument(file) && !file.split('/').some((part) => part.startsWith('.')),
  )
  const suggested =
    exact ||
    (!fresh && context.find((file) => !format || formatOf(file) === format))
  // A request can explicitly leave the filename to the writer. Preserve a
  // choice between named documents in that case, including different formats.
  const allowed = format
    ? [format]
    : initial.formats?.length
      ? initial.formats
      : [suggested ? formatOf(suggested) : 'tex']
  return { exact, suggested, allowed }
}

export function informalizationDocumentPath(job, snapshot) {
  const { suggested, allowed } = outputRequest(job, snapshot)
  if (suggested) return validateInformalizationOutputPath(suggested)
  // A new run should not take over a previous document with the default name.
  const occupied = new Set(
    [...snapshot.files, ...(snapshot.links || [])].map(
      ({ path }) => path.split('/')[0],
    ),
  )
  const extension = allowed.length === 1 ? allowed[0] : 'tex'
  let file = `Informalization.${extension}`
  for (let index = 2; occupied.has(file); index++)
    file = `Informalization-${index}.${extension}`
  return file
}

async function texRoot(file, content, snapshot, job, workspaces, signal) {
  const dir = path.posix.dirname(file)
  const magic = /^\s*%\s*!TeX\s+root\s*=\s*(.+?)\s*$/im.exec(content)?.[1]
  const code = content.replace(/(^|[^\\])%[^\n]*/g, '$1')
  if (!magic && /\\(?:documentclass\b|begin\s*\{document\})/.test(code))
    return file
  // The TeX worker captures the root's subtree. Its validated source map
  // confirms a fragment contributed to the PDF even for conditional includes.
  const candidates = new Set(
    snapshot.files
      .map(({ path }) => path)
      .filter((entry) => {
        const folder = entry.slice(0, entry.lastIndexOf('/') + 1)
        return (
          entry !== file &&
          isTexFile(entry) &&
          file.startsWith(folder) &&
          !entry.split('/').some((part) => part.startsWith('.'))
        )
      }),
  )
  if (magic) {
    if (!path.posix.isAbsolute(magic)) {
      const root = safeTexPath(path.posix.join(dir, magic))
      if (root === file || candidates.has(root)) return root
    }
    fail(
      `The TeX root named in ${file} is unavailable. Set % !TeX root to a project .tex file that includes it.`,
      409,
    )
  }
  if (candidates.size > 1 && workspaces) {
    const roots = [],
      linked = []
    // A large collection may include entire TeX books. Ask for an explicit
    // root instead of scanning an unbounded project on the application server.
    if (candidates.size <= 64) {
      let bytes = 0
      for (const candidate of candidates) {
        signal?.throwIfAborted()
        const { content } = await workspaces.readSnapshotFile(
          snapshot,
          candidate,
        )
        bytes += Buffer.byteLength(content)
        if (bytes > 8 * 1024 * 1024) {
          roots.length = 0
          linked.length = 0
          break
        }
        const source = content.replace(/(^|[^\\])%[^\n]*/g, '$1')
        if (!/\\(?:documentclass\b|begin\s*\{document\})/.test(source)) continue
        roots.push(candidate)
        const includes = source.matchAll(
          /\\(?:input|include|subfile)\s*\{([^}]+)\}/g,
        )
        for (const [, name] of includes) {
          const target = path.posix.join(
            path.posix.dirname(candidate),
            name.trim(),
          )
          if (target === file || target + '.tex' === file) {
            linked.push(candidate)
            break
          }
        }
      }
    }
    const discovered = linked.length ? linked : roots
    if (discovered.length === 1) return discovered[0]
    if (discovered.length) {
      candidates.clear()
      for (const root of discovered) candidates.add(root)
    }
  }
  const selected = [...new Set([job.currentFile, ...(job.files || [])])].filter(
    (name) => candidates.has(name),
  )
  if (selected.length === 1) return selected[0]
  const conventional = [...candidates].filter((name) =>
    /^main\.tex$/i.test(path.posix.basename(name)),
  )
  if (conventional.length === 1) return conventional[0]
  if (candidates.size === 1) return [...candidates][0]
  if (!candidates.size) return file
  fail(
    `Choose the root that includes ${file} by adding % !TeX root = path/to/main.tex to the fragment.`,
    409,
  )
}

// Markers identify the statement and the proof in any document language.
// Recognize common native labels as well so existing papers retain their style.
function translations(content, tex) {
  const anchor = tex ? /^% Lean: (.*)$/ : /^<!-- Lean: (.*) -->$/
  const proofMarker = tex ? '% Lean proof' : '<!-- Lean proof -->'
  const sections = new Map()
  let current, part
  let inMarkdownComment = false
  const addVisible = (value) => {
    if (!current || !part) return
    const body = (
      tex
        ? value
            .replace(
              /\\(?:begin|end|label|(?:sub)*section\*?|chapter\*?|title)\s*\{[^}]*\}(?:\[[^\]]*\])?/g,
              '',
            )
            .replace(/\\(?:noindent|qedhere|qed)\b/g, '')
            .replace(/\\(?:textbf|emph|textit)\{(.*?)\}/g, '$1')
        : value
    ).trim()
    if (!/[\p{L}\p{N}]/u.test(body) || /^#{1,6}\s/.test(body)) return
    const words = body.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (
      /^(?:to[ -]?do|tbd|fixme|sorry|admit|placeholder|proof omitted|proof goes here)\b/i.test(
        words,
      )
    )
      return
    if (/^(?:theorem|lemma|proposition|statement|proof|sketch)$/i.test(words))
      return
    current[part].push(body)
  }
  for (const value of (content || '').split(/\r?\n/)) {
    const line = value.trim()
    const match = anchor.exec(line)
    if (match && !inMarkdownComment) {
      if (!sections.has(match[1]))
        sections.set(match[1], { statement: [], proof: [] })
      current = sections.get(match[1])
      part = 'statement'
      continue
    }
    if (line === proofMarker && !inMarkdownComment) {
      part = 'proof'
      continue
    }
    let visible = line
    let endDocument
    if (tex) {
      visible = line.replace(/(^|[^\\])%.*/, '$1')
      if (/\\begin\s*\{document\}/.test(visible)) {
        sections.clear()
        current = undefined
      }
      endDocument = /\\end\s*\{document\}/.exec(visible)
      if (endDocument) visible = visible.slice(0, endDocument.index)
    } else {
      if (inMarkdownComment) {
        if (!visible.includes('-->')) continue
        visible = visible.slice(visible.indexOf('-->') + 3)
        inMarkdownComment = false
      }
      visible = visible.replace(/<!--[\s\S]*?-->/g, '')
      if (visible.includes('<!--')) {
        visible = visible.slice(0, visible.indexOf('<!--'))
        inMarkdownComment = true
      }
    }
    const boundary = (
      tex
        ? /\\begin\s*\{proof\}(?:\[[^\]]*\])?|(?:\\noindent\s*)?\\(?:paragraph\*?|textbf|emph|textit)\s*\{proof(?: sketch)?[.:]?\}[.:]?|^proof(?: sketch)?[.:](?=\s|$)/i
        : /^(?:#{1,6}\s*)?[*_]{0,2}proof(?: sketch)?\b[.:]?[*_]{0,2}[.:]?(?=\s|$)/i
    ).exec(visible)
    if (boundary) {
      addVisible(visible.slice(0, boundary.index))
      part = 'proof'
      visible = visible.slice(boundary.index + boundary[0].length)
    }
    const endProof = tex && /\\end\s*\{proof\}/.exec(visible)
    addVisible(endProof ? visible.slice(0, endProof.index) : visible)
    if (endProof) part = undefined
    if (endDocument) break
  }
  return sections
}

function requiresProofs(job, followups) {
  let required = true
  for (const text of [
    job.prompt,
    ...(followups || [])
      .filter(({ status }) => status === 'accepted')
      .map(({ text }) => text),
  ]) {
    if (
      /\b(?:don't|do not|never)\s+(?:omit|skip|exclude)\s+(?:the )?proofs?\b/i.test(
        text || '',
      )
    ) {
      required = true
      continue
    }
    if (
      /\b(?:statements?[- ]only|only (?:the )?(?:theorem )?statements?|(?:without|omit|skip|no) (?:the )?proofs?)\b/i.test(
        text || '',
      )
    )
      required = false
    else if (
      /\b(?:include|add|give|write|explain)\s+(?:the\s+)?proofs?\b/i.test(
        text || '',
      )
    )
      required = true
  }
  return required
}

export function addedInformalizationReferences(change) {
  const file = validateInformalizationOutputPath(change.path)
  const tex = isTexFile(file)
  const previous = translations(change.before, tex)
  const updated = translations(change.after, tex)
  const references = []
  for (const [key, lines] of updated) {
    if (JSON.stringify(previous.get(key)) === JSON.stringify(lines)) continue
    const match = /^(.+?\.lean)#(.+)$/.exec(key)
    if (!match || !lines.statement.length)
      fail(
        `Every added source reference in ${file} needs a path.lean#name and its translation. Check "${key.slice(0, 180)}".`,
        409,
      )
    references.push({ path: relativeFile(match[1]), name: match[2] })
  }
  return references
}

function assertSourceAnchors(file, before, after, entries, proofs) {
  const tex = isTexFile(file)
  const original = translations(before, tex)
  const updated = translations(after, tex)
  const keys = entries.map(({ path, name }) => `${path}#${name}`)
  const missing = keys.filter(
    (key) =>
      !updated.get(key)?.statement.length ||
      (proofs && !updated.get(key)?.proof.length),
  )
  if (missing.length)
    fail(
      `${file} needs a source reference and a substantive ${proofs ? 'statement and proof' : 'statement'} for ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}. Place the source reference before the statement.${proofs ? ' Use a proof heading or a Lean proof comment before the proof.' : ''}`,
      409,
    )
  if (
    keys.length &&
    keys.every(
      (key) =>
        JSON.stringify(updated.get(key)) === JSON.stringify(original.get(key)),
    )
  )
    fail(
      `Revise or add the requested translation in ${file}. The text following its source references has not changed.`,
      409,
    )
}

export async function verifyInformalizationDocument({
  job,
  snapshot,
  changes,
  entries,
  texBuilds,
  workspaces,
  signal,
  followups,
}) {
  signal?.throwIfAborted()
  if (changes.length !== 1 || !isDocument(changes[0].path))
    fail(
      'Informalize must create or update one TeX or Markdown document. Keep all other project files unchanged.',
      409,
    )
  const { path: file, before, after } = changes[0]
  validateInformalizationOutputPath(file)
  if (typeof after !== 'string' || !after.trim())
    fail(`The informalization has no document content in ${file}.`, 409)
  const { exact, allowed } = outputRequest(job, snapshot, followups)
  if (exact && exact !== file)
    fail(
      `The requested document is ${exact}, but the draft changes ${file}.`,
      409,
    )
  if (!allowed.includes(formatOf(file)))
    fail(
      `This informalization requires a ${allowed.includes('tex') ? 'TeX' : 'Markdown'} document. The draft changes ${file}.`,
      409,
    )
  assertSourceAnchors(
    file,
    before,
    after,
    entries,
    requiresProofs(job, followups),
  )
  if (!isTexFile(file)) return { path: file }
  if (!texBuilds)
    fail(
      'A TeX worker is required to compile this document. Configure the TeX worker or choose a Markdown output.',
      503,
    )
  if (!snapshot.root || !job.id)
    fail(
      'The final document copy is unavailable. Retry the informalization.',
      409,
    )
  const rootFile = await texRoot(file, after, snapshot, job, workspaces, signal)
  const build = await texBuilds.start(
    job.owner,
    job.projectId,
    { rootFile },
    {
      origin: 'agent',
      waitForProject: true,
      runId: job.id,
      sourceRoot: snapshot.root,
      signal,
      ...(snapshot.purpose === 'verification'
        ? { verificationRunId: snapshot.runId }
        : {}),
      ...(rootFile === file ? {} : { requiredTexSource: file }),
    },
  )
  const result = await texBuilds.wait(job.owner, build.id)
  signal?.throwIfAborted()
  if (result.status !== 'completed' || !result.pdf) {
    const diagnostic = result.diagnostics?.find(
      ({ severity }) => severity === 'error',
    )
    const location = diagnostic?.path
      ? ` (${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}` : ''})`
      : ''
    fail(
      `Could not build ${rootFile}. ${diagnostic ? diagnostic.message + location : result.error || (result.status === 'cancelled' ? 'The build was stopped.' : 'The build did not produce a PDF.')}`,
      409,
    )
  }
  return { path: file, buildId: result.id }
}
