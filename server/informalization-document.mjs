import path from 'node:path'
import { isTexFile, safeTexPath } from '../shared/tex.mjs'
import {
  markdownChapterLinks,
  texChapterLinks,
} from './workspace-references.mjs'
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

async function texRoot(
  file,
  content,
  snapshot,
  job,
  workspaces,
  signal,
  known,
) {
  const dir = path.posix.dirname(file)
  const magic = /^\s*%\s*!TeX\s+root\s*=\s*(.+?)\s*$/im.exec(content)?.[1]
  const code = content.replace(/(^|[^\\])%[^\n]*/g, '$1')
  if (!magic && /\\(?:documentclass\b|begin\s*\{document\})/.test(code))
    return file
  // The TeX worker captures the root's subtree. Its validated source map
  // confirms a fragment contributed to the PDF even for conditional includes.
  const candidates = new Set(
    [...known].filter((entry) => {
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

export function informalizationDocumentChanges(changes) {
  if (!changes.length)
    fail(
      'No paper was written. Ask Lemex to create or update the document.',
      409,
    )
  for (const change of changes) {
    if (!isDocument(change.path))
      fail(
        `The paper includes an unrelated edit to ${change.path}. Keep edits in the paper’s TeX or Markdown files.`,
        409,
      )
    validateInformalizationOutputPath(change.path)
    if (typeof change.after !== 'string' || !change.after.trim())
      fail(`The paper has no document content in ${change.path}.`, 409)
  }
  return changes.map(({ path }) => path)
}

async function assertSourceAnchors(changes, entries, proofs, chapters) {
  const keys = new Set(entries.map(({ path, name }) => `${path}#${name}`))
  const covered = new Set()
  const translatedFiles = new Set()
  let revised = false
  for (const { path: file, before, after } of changes) {
    const tex = isTexFile(file)
    const original = translations(before, tex)
    for (const [key, lines] of translations(after, tex)) {
      if (
        !keys.has(key) ||
        !lines.statement.length ||
        (proofs && !lines.proof.length)
      )
        continue
      covered.add(key)
      translatedFiles.add(file)
      if (JSON.stringify(lines) !== JSON.stringify(original.get(key)))
        revised = true
    }
  }
  // Existing chapters may already cover part of the request. Count them only
  // when they are reachable from this paper; TeX coverage also needs PDF evidence.
  if (revised && covered.size < keys.size) {
    const edited = new Set(changes.map((change) => change.path))
    for await (const { file, content } of chapters) {
      if (edited.has(file)) continue
      for (const [key, lines] of translations(content, isTexFile(file))) {
        if (
          !keys.has(key) ||
          covered.has(key) ||
          !lines.statement.length ||
          (proofs && !lines.proof.length)
        )
          continue
        covered.add(key)
        translatedFiles.add(file)
      }
      if (covered.size === keys.size) break
    }
  }
  const missing = [...keys].filter((key) => !covered.has(key))
  if (missing.length)
    fail(
      `The paper needs a source reference and a substantive ${proofs ? 'statement and proof' : 'statement'} for ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`,
      409,
    )
  if (!revised)
    fail(
      'Revise or add the requested translation in the paper. Its checked statements and proofs have not changed.',
      409,
    )
  return translatedFiles
}

const standaloneTex = (content) =>
  /\\(?:documentclass\b|begin\s*\{document\})/.test(
    content.replace(/(^|[^\\])%[^\n]*/g, '$1'),
  )

export function informalizationDraftPath(job, snapshot, changes, followups) {
  const { exact, suggested } = outputRequest(job, snapshot, followups)
  const paths = new Set(changes.map((change) => change.path))
  if (
    exact &&
    (paths.has(exact) || snapshot.files.some((file) => file.path === exact))
  )
    return exact
  if (paths.size === 1) return changes[0].path
  if (paths.has(suggested)) return suggested
  const root = changes.find(
    (change) => isTexFile(change.path) && standaloneTex(change.after),
  )
  if (root) return root.path
  const targets = new Set()
  for (const change of changes) {
    if (isTexFile(change.path)) continue
    for (const link of markdownChapterLinks(change.after, change.path, paths))
      targets.add(link)
  }
  return (
    changes.find((change) => !targets.has(change.path))?.path || changes[0].path
  )
}

async function* paperChapters(root, known, read, signal) {
  const links = isTexFile(root) ? texChapterLinks : markdownChapterLinks
  const reached = new Set([root])
  let bytes = 0
  for (const file of reached) {
    signal?.throwIfAborted()
    const content = await read(file)
    bytes += Buffer.byteLength(content)
    if (bytes > 16 * 1024 * 1024)
      fail(
        'This paper exceeds the chapter scan limit. Select a smaller part of the paper.',
        409,
      )
    yield { file, content }
    for (const linked of links(content, file, known, root)) {
      if (formatOf(linked) === formatOf(root)) reached.add(linked)
    }
  }
}

async function checkPaperLinks(root, required, chapters) {
  const missing = new Set(required)
  missing.delete(root)
  if (!missing.size) return
  for await (const { file } of chapters) {
    missing.delete(file)
    if (!missing.size) return
  }
  if (missing.size)
    fail(
      `The paper at ${root} must link or include the edited files: ${[...missing].join(', ')}.`,
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
  const paths = informalizationDocumentChanges(changes)
  const { exact, allowed } = outputRequest(job, snapshot, followups)
  const changed = new Map(changes.map((change) => [change.path, change.after]))
  const known = new Set(
    [...snapshot.files.map((entry) => entry.path), ...paths].filter(
      (name) =>
        isDocument(name) &&
        !name.split('/').some((part) => part.startsWith('.')),
    ),
  )
  const requestedError = () =>
    fail(
      `The requested document is ${exact}, but the draft changes ${paths.join(', ')}.`,
      409,
    )
  if (exact && (!known.has(exact) || (!changed.has(exact) && !workspaces)))
    requestedError()
  if (
    paths.some((file) => !allowed.includes(formatOf(file))) ||
    new Set(paths.map(formatOf)).size !== 1
  )
    fail(
      `This informalization requires a ${allowed.includes('tex') ? 'TeX' : 'Markdown'} document. The draft changes ${paths.join(', ')}.`,
      409,
    )
  const read = async (name) =>
    changed.get(name) ??
    (await workspaces.readSnapshotFile(snapshot, name)).content
  const chapters = (root) => paperChapters(root, known, read, signal)
  const checkCoverage = (root) =>
    assertSourceAnchors(
      changes,
      entries,
      requiresProofs(job, followups),
      chapters(root),
    )
  const report = (file) => ({
    path: file,
    ...(paths.length > 1 || file !== paths[0] ? { paths } : {}),
  })
  let file = informalizationDraftPath(job, snapshot, changes, followups)
  if (!isTexFile(file)) {
    await checkCoverage(file)
    await checkPaperLinks(file, paths, chapters(file))
    return report(file)
  }
  const roots = changes.filter((change) => standaloneTex(change.after))
  if (roots.length > 1)
    fail(
      'Choose one main TeX file for this paper and include its chapters from there.',
      409,
    )
  const rootFile =
    roots.length && !exact
      ? roots[0].path
      : await texRoot(
          file,
          await read(file),
          snapshot,
          job,
          workspaces,
          signal,
          known,
        )
  if (roots.length && roots[0].path !== rootFile)
    fail(
      `The paper’s main file must include the requested document ${file}.`,
      409,
    )
  if (!exact && paths.length > 1) file = rootFile
  // A named root may receive new text through included chapters. A named
  // fragment must actually receive an edit.
  if (exact && !changed.has(exact) && exact !== rootFile) requestedError()
  const translatedFiles = await checkCoverage(rootFile)
  await checkPaperLinks(
    rootFile,
    paths.filter((name) => !translatedFiles.has(name)),
    chapters(rootFile),
  )
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
      requiredTexSources: [...translatedFiles].filter(
        (name) => name !== rootFile,
      ),
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
  return { ...report(file), buildId: result.id }
}
