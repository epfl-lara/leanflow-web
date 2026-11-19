interface TextItem {
  str: string
  hasEOL?: boolean
}

interface TextPosition {
  item: number
  offset: number
}

interface QuoteRange {
  start: TextPosition
  end: TextPosition
}

const maxPageCharacters = 200_000
const wordCharacter = /[\p{L}\p{M}\p{N}_]/u

function normalise(text: string) {
  return text.normalize('NFKD').replaceAll('\u00ad', '')
}

function wordAt(text: string, offset: number) {
  if (offset < 0 || offset >= text.length) return false
  const code = text.charCodeAt(offset)
  const start =
    code >= 0xdc00 && code <= 0xdfff && offset > 0 ? offset - 1 : offset
  const point = text.codePointAt(start)
  return point !== undefined && wordCharacter.test(String.fromCodePoint(point))
}

export function indexPdfQuotes(items: readonly TextItem[]) {
  if (items.reduce((size, { str }) => size + str.length, 0) > maxPageCharacters)
    return () => null

  const characters: string[] = []
  const starts: (TextPosition | null)[] = []
  const ends: (TextPosition | null)[] = []
  let separator = false
  for (const [item, { str, hasEOL }] of items.entries()) {
    let offset = 0
    for (const original of str) {
      const end = offset + original.length
      for (const character of normalise(original)) {
        if (/\s/u.test(character)) {
          separator = characters.length > 0
          continue
        }
        if (separator) {
          characters.push(' ')
          starts.push(null)
          ends.push(null)
          separator = false
        }
        characters.push(character)
        for (let i = 0; i < character.length; i++) {
          starts.push({ item, offset })
          ends.push({ item, offset: end })
        }
      }
      offset = end
    }
    if (hasEOL && characters.length) separator = true
  }
  const text = characters.join('')

  return (quote: string): QuoteRange | null => {
    const search = normalise(quote).replace(/\s+/gu, ' ').trim()
    if (!search) return null
    let found: QuoteRange | null = null
    for (
      let index = text.indexOf(search);
      index >= 0;
      index = text.indexOf(search, index + 1)
    ) {
      const after = index + search.length
      if (
        (wordAt(search, 0) && wordAt(text, index - 1)) ||
        (wordAt(search, search.length - 1) && wordAt(text, after))
      )
        continue
      const start = starts[index]
      const end = ends[after - 1]
      if (!start || !end) continue
      if (found) return null
      found = { start, end }
    }
    return found
  }
}
