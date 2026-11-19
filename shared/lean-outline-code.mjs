// This lexical mask only labels ranges already supplied by Lean and recognizes
// the import header. It never guesses the extent of a proof. Keeping newlines
// and UTF-16 offsets intact lets masked source retain the editor's coordinates.
export function outlineCode(content, { keepQuotedIdentifiers = false } = {}) {
  const characters = content.split('')
  const blank = (start, end) => {
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
      if (!keepQuotedIdentifiers || quotationDepth) blank(start, index)
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

const declarationKinds = new Set([
  'theorem',
  'lemma',
  'def',
  'example',
  'structure',
  'inductive',
  'abbrev',
  'instance',
])

export function declarationKeyword(source) {
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
    if (!token) return undefined
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
    return declarationKinds.has(token)
      ? { kind: token, offset: index }
      : undefined
  }
  return undefined
}
