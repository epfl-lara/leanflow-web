import { validateClientUris } from './rpc.mjs'
import { createHash } from 'node:crypto'

// The language client suppresses ContentModified errors on rename. RequestFailed
// lets the rename UI show the reason and the action the user can take.
const failed = (message) => Object.assign(new Error(message), { code: -32803 })

const changed = () =>
  failed(
    'The source changed while Lean prepared the rename. Try renaming again.',
  )

const invalidName = (message) =>
  Object.assign(new Error(message), { code: -32602 })

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++)
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}
function offsetAt(text, position, starts = lineStarts(text)) {
  if (
    !Number.isSafeInteger(position?.line) ||
    position.line < 0 ||
    !Number.isSafeInteger(position?.character) ||
    position.character < 0
  )
    throw changed()
  const start = starts[position.line]
  if (start === undefined) throw changed()
  const newline = text.indexOf('\n', start)
  let end = newline < 0 ? text.length : newline
  if (text[end - 1] === '\r') end--
  if (position.character > end - start) throw changed()
  return start + position.character
}

function rangeOffsets(text, range, starts) {
  const start = offsetAt(text, range?.start, starts)
  const end = offsetAt(text, range?.end, starts)
  if (end < start) throw changed()
  return { start, end }
}

// Dots inside Lean's escaped identifiers (e.g. «a.b») are not qualifiers.
// Lean's identifier character classes, from Init/Meta/Defs.lean.
const letters =
  'A-Za-z_\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u017f\\u0391-\\u039f\\u03a1-\\u03a2\\u03a4-\\u03a9\\u03b1-\\u03ba\\u03bc-\\u03fb\\u1f00-\\u1ffe\\u2100-\\u214f\\u{1d49c}-\\u{1d59f}'
const firstCharacter = '[' + letters + ']'
const restCharacter =
  '[' + letters + "0-9'!?\\u2080-\\u2089\\u2090-\\u209c\\u1d62-\\u1d6a\\u2c7c]"
const nameSegment = '(?:«[^«»\\r\\n]+»|' + firstCharacter + restCharacter + '*)'
const validName = new RegExp(
  '^' + nameSegment + '(?:\\.' + nameSegment + ')*$',
  'u',
)
const identifierTokens = new RegExp(
  '\\.?' + nameSegment + '(?:\\.' + nameSegment + ')*',
  'gu',
)
const continuesAfter = new RegExp('^(?:' + restCharacter + '|[«»])', 'u')
const continuesBefore = new RegExp('(?:' + restCharacter + '|[«»])$', 'u')
function nameParts(text) {
  return typeof text === 'string' && validName.test(text)
    ? text.match(/«[^«»\r\n]+»|[^.]+/gu)
    : null
}
const normalizedLeaf = (name) =>
  name.startsWith('«') ? name.slice(1, -1) : name
function identifierAt(text, position, starts) {
  const offset = offsetAt(text, position, starts)
  const begin = starts[position.line],
    end = text.indexOf('\n', begin)
  const line = text.slice(begin, end < 0 ? text.length : end)
  for (const match of line.matchAll(identifierTokens))
    if (
      match.index <= offset - begin &&
      offset - begin <= match.index + match[0].length
    ) {
      const name = referenceName(match[0])
      if (name) return normalizedLeaf(name.leaf)
    }
  throw changed()
}

function referenceName(text) {
  const parts = nameParts(text.startsWith('.') ? text.slice(1) : text)
  if (!parts) return null
  const leaf = parts.at(-1)
  return { leaf, prefix: text.slice(0, -leaf.length) }
}

function referenceAt(text, range, starts) {
  const { start, end } = rangeOffsets(text, range, starts)
  const name = referenceName(text.slice(start, end))
  // A reference index can briefly lag behind a freshly renamed import. Never
  // accept an old range ending inside the new identifier (e.g. blank in blankC).
  if (
    name &&
    (continuesAfter.test(text.slice(end, end + 2)) ||
      continuesBefore.test(text.slice(Math.max(0, start - 2), start)))
  )
    throw changed()
  return name
}

function editGroups(result) {
  const groups = Object.entries(result?.changes || {}).map(([uri, edits]) => ({
    uri,
    edits,
  }))
  for (const change of result?.documentChanges || []) {
    if (!change.textDocument || !Array.isArray(change.edits))
      throw failed(
        'Lean returned an unsupported rename. Rename this identifier manually.',
      )
    groups.push({
      uri: change.textDocument.uri,
      version: change.textDocument.version,
      edits: change.edits,
    })
  }
  return groups
}

// Older Lean servers drop qualifiers and constructor dots from renamed references.
// Preserve each reference's spelling and keep symbol renames in their existing scope.
export class LeanRenames {
  constructor({ readFile, sendToClient }) {
    Object.assign(this, { readFile, sendToClient })
    this.documents = new Map()
    this.pending = new Map()
  }

  track(message) {
    const document = message.params?.textDocument
    const uri = document?.uri
    if (message.method === 'textDocument/didOpen') {
      this.documents.set(uri, {
        text: document.text,
        version: document.version,
      })
    } else if (message.method === 'textDocument/didClose') {
      this.documents.delete(uri)
    } else if (message.method === 'textDocument/didChange') {
      if (!this.documents.has(uri)) return
      let text = this.documents.get(uri)?.text
      for (const change of message.params.contentChanges || []) {
        if (!change.range) text = change.text
        else if (typeof text === 'string') {
          try {
            const { start, end } = rangeOffsets(text, change.range)
            text = text.slice(0, start) + change.text + text.slice(end)
          } catch {
            // Tracking is advisory: never disconnect Lean for a buffer we cannot
            // reconstruct. Refuse renames until a full document update restores it.
            text = undefined
          }
        }
      }
      this.documents.set(uri, { text, version: document.version })
    } else if (message.method === '$/cancelRequest') {
      this.pending.delete(message.params?.id)
    } else if (
      ['textDocument/rename', 'textDocument/prepareRename'].includes(
        message.method,
      ) &&
      'id' in message
    ) {
      this.pending.set(message.id, {
        method: message.method,
        uri,
        newName: message.params.newName,
        position: message.params.position,
        documents: new Map(this.documents),
        sources: new Map(),
        lines: new Map(),
      })
    }
  }

  async #source(uri, request, version) {
    validateClientUris({ params: { uri } })
    const url = new URL(uri)
    if (url.protocol !== 'file:' || url.search || url.hash)
      throw failed('This rename includes a file outside the editable project.')
    const filename = decodeURIComponent(url.pathname).slice(
      '/workspace/'.length,
    )
    if (!filename.endsWith('.lean') || filename.startsWith('.lake/'))
      throw failed(
        'This rename includes a read-only file. Rename only project declarations.',
      )
    const captured = request.documents.get(uri)
    if (captured && typeof captured.text !== 'string')
      throw failed(
        'The editor buffer is out of sync. Reopen the file, then rename again.',
      )
    if (
      this.documents.get(uri) !== captured ||
      (version !== undefined &&
        version !== null &&
        version !== captured?.version)
    )
      throw changed()
    if (request.sources.has(uri)) return request.sources.get(uri).content
    const saved =
      !captured || request.includeSources ? await this.readFile(filename) : null
    const savedText = typeof saved === 'string' ? saved : saved?.content
    const text = captured ? captured.text : savedText
    if (typeof text !== 'string') throw changed()
    if (request.includeSources && typeof savedText !== 'string') throw changed()
    const source = {
      uri,
      path: filename,
      content: text,
      ...(typeof savedText === 'string'
        ? {
            hash: createHash('sha256').update(savedText).digest('hex'),
            unsaved: text !== savedText,
          }
        : {}),
    }
    if (request.includeSources) {
      request.sourceBytes =
        (request.sourceBytes || 0) + Buffer.byteLength(JSON.stringify(source))
      if (request.sourceBytes > 32 * 1024 * 1024)
        throw failed(
          'This rename needs more source text than the editor can load at once.',
        )
    }
    request.lines.set(uri, lineStarts(text))
    request.sources.set(uri, source)
    return text
  }

  receive(message) {
    if (message.method || !('id' in message)) return true
    const request = this.pending.get(message.id)
    if (!request) return true
    void this.#reply(message, request)
    return false
  }

  async #reply(message, request) {
    try {
      if (message.result) if (request.index) await request.index.validate()
      if (
        message.result &&
        !(
          request.method === 'textDocument/prepareRename' &&
          message.result.defaultBehavior === true
        )
      ) {
        if (request.method === 'textDocument/prepareRename') {
          const range = message.result.range || message.result
          const text = await this.#source(request.uri, request)
          const name = referenceAt(text, range, request.lines.get(request.uri))
          if (
            name &&
            normalizedLeaf(name.leaf) !==
              identifierAt(
                text,
                request.position,
                request.lines.get(request.uri),
              )
          )
            throw changed()
          // The rename box must offer the leaf even when invoked on Cell.blank
          // or .empty; submitting a qualified name can change a declaration's scope.
          if (name?.prefix && range.start.line === range.end.line) {
            message.result = {
              ...('range' in message.result ? message.result : {}),
              range: {
                start: {
                  ...range.end,
                  character: range.end.character - name.leaf.length,
                },
                end: range.end,
              },
              placeholder: name.leaf,
            }
          }
        } else {
          const requested =
            typeof request.newName === 'string'
              ? referenceName(request.newName)
              : null
          if (!requested)
            throw invalidName(
              'Enter a Lean identifier. Use « and » around names containing spaces or dots.',
            )
          const groups = editGroups(message.result)
          if (groups.length > 1000)
            throw failed('This rename affects too many files at once.')
          request.includeSources = groups.some(
            ({ uri, edits }) => uri !== request.uri && edits.length,
          )
          const origin = await this.#source(request.uri, request)
          const oldName = identifierAt(
            origin,
            request.position,
            request.lines.get(request.uri),
          )
          const replacements = []
          for (const { uri, version, edits } of groups) {
            const text = await this.#source(uri, request, version)
            for (const edit of edits) {
              const name = referenceAt(text, edit.range, request.lines.get(uri))
              if (!name || normalizedLeaf(name.leaf) !== oldName)
                throw changed()
              replacements.push({ edit, name })
            }
          }
          // Accept a qualifier copied from an existing use, but never move a
          // declaration into a new namespace as a side effect of symbol rename.
          if (
            requested.prefix &&
            !replacements.some(({ name }) => name?.prefix === requested.prefix)
          )
            throw invalidName(
              'Enter only the final identifier name, without a new namespace. Symbol rename preserves the declaration’s namespace.',
            )
          for (const { edit, name } of replacements)
            if (edit.newText === request.newName && name)
              edit.newText = name.prefix + requested.leaf
          if (request.includeSources) {
            const sources = [...request.sources.values()]
            // The client loads these exact buffers before the native workspace
            // edit runs. Hashes remain the base for one conflict-checked Save.
            message.result.leanflowSources = sources
          }
        }
        // File reads yield: a keystroke, cancellation or close must still win.
        if (request.index) await request.index.validate()
        for (const uri of request.sources.keys())
          if (this.documents.get(uri) !== request.documents.get(uri))
            throw changed()
      }
    } catch (error) {
      message = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: [-32803, -32602].includes(error.code) ? error.code : -32803,
          message: [-32803, -32602].includes(error.code)
            ? error.message
            : 'Lean could not safely prepare the rename. Check that all affected files are editable and try again.',
        },
      }
    }
    if (this.pending.get(message.id) !== request) return
    this.pending.delete(message.id)
    this.sendToClient(message)
  }

  dispose() {
    this.pending.clear()
    this.documents.clear()
  }
}
