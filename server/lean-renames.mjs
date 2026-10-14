import { validateClientUris } from './rpc.mjs'

// The language client suppresses ContentModified errors on rename. RequestFailed
// lets the rename UI show the reason and the action the user can take.
const failed = (message) => Object.assign(new Error(message), { code: -32803 })

const changed = () =>
  failed(
    'The source changed while Lean prepared the rename. Try renaming again.',
  )

const invalidName = (message) =>
  Object.assign(new Error(message), { code: -32602 })

function offsetAt(text, position) {
  if (
    !Number.isSafeInteger(position?.line) ||
    position.line < 0 ||
    !Number.isSafeInteger(position?.character) ||
    position.character < 0
  )
    throw changed()
  let start = 0
  for (let line = 0; line < position.line; line++) {
    const end = text.indexOf('\n', start)
    if (end < 0) throw changed()
    start = end + 1
  }
  const newline = text.indexOf('\n', start)
  let end = newline < 0 ? text.length : newline
  if (text[end - 1] === '\r') end--
  if (position.character > end - start) throw changed()
  return start + position.character
}

function rangeOffsets(text, range) {
  const start = offsetAt(text, range?.start)
  const end = offsetAt(text, range?.end)
  if (end < start) throw changed()
  return { start, end }
}

// Dots inside Lean's escaped identifiers (e.g. «a.b») are not qualifiers.
function nameParts(text) {
  return typeof text === 'string' &&
    /^(?:[^.\s«»]+|«[^«»\r\n]+»)(?:\.(?:[^.\s«»]+|«[^«»\r\n]+»))*$/u.test(text)
    ? text.match(/«[^«»\r\n]+»|[^.]+/gu)
    : null
}

function referenceName(text) {
  const parts = nameParts(text.startsWith('.') ? text.slice(1) : text)
  if (!parts) return null
  const leaf = parts.at(-1)
  return { leaf, prefix: text.slice(0, -leaf.length) }
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
        documents: new Map(this.documents),
        sources: new Set(),
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
    request.sources.add(uri)
    const text = captured ? captured.text : await this.readFile(filename)
    if (typeof text !== 'string') throw changed()
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
          const { start, end } = rangeOffsets(text, range)
          const name = referenceName(text.slice(start, end))
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
          // The web editor saves one buffer. Returning other files would leave
          // unsaved edits in hidden VS Code models or fail during bulk application.
          if (
            groups.some(({ uri, edits }) => uri !== request.uri && edits.length)
          )
            throw failed(
              'This rename affects multiple files. LeanFlow cannot apply it safely yet. Use VS Code for this rename.',
            )
          const replacements = []
          for (const { uri, version, edits } of groups) {
            const text = await this.#source(uri, request, version)
            for (const edit of edits) {
              const { start, end } = rangeOffsets(text, edit.range)
              const name = referenceName(text.slice(start, end))
              if (edit.newText === request.newName && !name) throw changed()
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
        }
        // File reads yield: a keystroke, cancellation or close must still win.
        for (const uri of request.sources)
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
