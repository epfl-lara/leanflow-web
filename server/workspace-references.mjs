import path from 'node:path'

const markdownExtension =
  /\.(?:md|mkd|mdwn|mdown|markdown|markdn|mdtxt|mdtext|workbook)$/i
const moduleSegment = /^(?:[\p{L}_][\p{L}\p{N}_']*|«[^»\r\n]+»)$/u
const moduleToken =
  /(?:[\p{L}_][\p{L}\p{N}_']*|«[^»\r\n]+»)(?:\.(?:[\p{L}_][\p{L}\p{N}_']*|«[^»\r\n]+»))*/gu

class ReferenceScanSkipped extends Error {}

export function isReferenceFile(filename) {
  return /\.(?:lean|tex)$/i.test(filename) || markdownExtension.test(filename)
}

export function createReferencePathMapper({ from, to, moves, files }) {
  const known = files instanceof Set ? files : new Set(files)
  const exact = new Map()
  const folders = []
  for (const move of moves || [{ from, to }]) {
    if (known.has(move.from)) exact.set(move.from, move.to)
    else folders.push(move)
  }
  folders.sort((left, right) => right.from.length - left.from.length)
  return (filename) => {
    if (exact.has(filename)) return exact.get(filename)
    for (const move of folders)
      if (filename === move.from || filename.startsWith(move.from + '/'))
        return move.to + filename.slice(move.from.length)
    return filename
  }
}

function normalized(base, value) {
  const parts = base === '.' ? [] : base.split('/')
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/') || null
}

function escaped(source, index) {
  let count = 0
  while (source[--index] === '\\') count++
  return count % 2 === 1
}

function encodePathCharacter(char) {
  const encoded = encodeURIComponent(char)
  return encoded === char
    ? `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    : encoded
}

function applyEdits(source, edits) {
  edits.sort((left, right) => left.start - right.start || left.end - right.end)
  const chunks = []
  let offset = 0,
    count = 0
  for (const edit of edits) {
    if (edit.start < offset) continue
    chunks.push(source.slice(offset, edit.start), edit.value)
    offset = edit.end
    count++
  }
  chunks.push(source.slice(offset))
  return { content: chunks.join(''), count }
}

/** Hide code examples without changing source offsets. */
function markdownCode(source) {
  const spans = []
  let fence = null,
    start = 0
  while (start < source.length) {
    let end = source.indexOf('\n', start)
    if (end < 0) end = source.length
    const line = source.slice(start, end)
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.marker &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        spans.push({ start: fence.start, end })
        fence = null
      }
    } else if (marker)
      fence = { start, marker: marker[1][0], length: marker[1].length }
    else if (/^(?: {4}|\t)/.test(line)) spans.push({ start, end })
    start = end + 1
  }
  if (fence) spans.push({ start: fence.start, end: source.length })
  spans.sort((left, right) => left.start - right.start)
  const raw = /^[ \t]{0,3}<(script|style|pre|textarea)(?=[\s>])/gim
  let codeSpan = 0
  for (let match = raw.exec(source); match; match = raw.exec(source)) {
    while (spans[codeSpan]?.end <= match.index) codeSpan++
    if (spans[codeSpan]?.start <= match.index) {
      raw.lastIndex = spans[codeSpan].end
      continue
    }
    const closing = new RegExp(`</${match[1]}[ \\t]*>`, 'gi')
    closing.lastIndex = match.index + match[0].length
    const end = closing.exec(source)
    const boundary = end ? end.index + end[0].length : source.length
    spans.push({ start: match.index, end: boundary })
    raw.lastIndex = boundary
  }
  spans.sort((left, right) => left.start - right.start)
  let span = 0
  const runs = [],
    previous = new Map()
  for (let index = 0; index < source.length; index++) {
    while (spans[span]?.end <= index) span++
    if (spans[span]?.start <= index) {
      index = spans[span].end - 1
      previous.clear()
      continue
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      const boundary = end < 0 ? source.length : end + 3
      spans.push({ start: index, end: boundary })
      index = boundary - 1
    } else if (source[index] === '`') {
      let length = 1
      while (source[index + length] === '`') length++
      const run = {
        start: index,
        end: index + length,
        escaped: escaped(source, index),
      }
      const preceding = previous.get(length)
      if (preceding) preceding.next = run
      previous.set(length, run)
      runs.push(run)
      index += length - 1
    }
  }
  let end = 0
  for (const run of runs) {
    if (run.start < end || run.escaped || !run.next) continue
    end = run.next.end
    spans.push({ start: run.start, end })
  }
  return spans.sort((left, right) => left.start - right.start)
}

function markdownReferences(source, offset, add) {
  if (!source.includes('[')) return
  const spans = markdownCode(source)
  let span = 0
  const blocked = (start, end) => {
    while (spans[span]?.end <= start) span++
    return spans[span]?.start < end
  }
  const definitions =
    /^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*(?:<([^>\r\n]+)>|([^\s\r\n]+))/dgm
  for (const match of source.matchAll(definitions)) {
    const group = match[1] === undefined ? 2 : 1
    const [start, end] = match.indices[group]
    if (!blocked(match.index, end))
      add(offset + start, offset + end, match[group], group === 1)
  }
  span = 0
  const labels = []
  for (let index = 0; index < source.length; index++) {
    while (spans[span]?.end <= index) span++
    if (spans[span]?.start <= index) {
      index = spans[span].end - 1
      continue
    }
    const char = source[index]
    if (char === '\n' || char === '\r') labels.length = 0
    else if (char === '[' && !escaped(source, index)) {
      if (labels.length < 64) labels.push(index)
    } else if (char === ']' && !escaped(source, index) && labels.length) {
      const label = labels.pop()
      if (
        source[index + 1] !== '(' ||
        escaped(source, source[label - 1] === '!' ? label - 1 : label)
      )
        continue
      let start = index + 2
      while (source[start] === ' ' || source[start] === '\t') start++
      const angle = source[start] === '<'
      if (angle) start++
      let end = start,
        depth = 0
      while (end < source.length && end - start < 4096) {
        const current = source[end]
        if (current === '\n' || current === '\r') break
        if (current === '\\') {
          end += 2
          continue
        }
        if (angle ? current === '>' : current === ')' && depth === 0) break
        if (!angle && /\s/.test(current) && depth === 0) break
        if (!angle && current === '(') depth++
        else if (!angle && current === ')') depth--
        end++
      }
      if (end === start) continue
      if (end - start >= 4096 || (angle && source[end] !== '>'))
        throw new ReferenceScanSkipped()
      let closing = angle ? end + 1 : end
      while (source[closing] === ' ' || source[closing] === '\t') closing++
      if (source[closing] === '"' || source[closing] === "'") {
        const quote = source[closing++]
        while (
          closing < source.length &&
          source[closing] !== '\n' &&
          source[closing] !== '\r' &&
          (source[closing] !== quote || escaped(source, closing))
        )
          closing++
        if (source[closing] !== quote) throw new ReferenceScanSkipped()
        closing++
        while (source[closing] === ' ' || source[closing] === '\t') closing++
      }
      if (source[closing] !== ')') throw new ReferenceScanSkipped()
      if (blocked(start, closing)) continue
      add(offset + start, offset + end, source.slice(start, end), angle)
      index = closing
    }
  }
}

/** Collect actual Lean comments and mask literals before looking for imports. */
function leanRegions(source) {
  const comments = [],
    hidden = [],
    strings = []
  const raw = /r(#{0,})"/y
  const character = /'(?:\\(?:u\{[0-9a-fA-F]+\}|[^\r\n])|[^'\\\r\n])'/uy
  let index = 0
  while (index < source.length) {
    const string = strings.at(-1)
    if (string && !string.depth) {
      if (source[index] === '\\') index += 2
      else if (source[index] === '"') {
        strings.pop()
        index++
        if (!strings.length) hidden.push({ start: string.start, end: index })
      } else if (string.interpolated && source[index] === '{') {
        if (source[index + 1] === '{') index += 2
        else {
          string.depth++
          index++
        }
      } else index++
      continue
    }
    const start = index
    if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end
      comments.push({ start: start + 2, end: index })
      hidden.push({ start, end: index })
    } else if (source.startsWith('/-', index)) {
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
      comments.push({ start: start + 2, end: depth ? index : index - 2 })
      hidden.push({ start, end: index })
    } else if (
      source[index] === 'r' &&
      !/[\p{L}\p{N}_']/u.test(source[index - 1] || '')
    ) {
      raw.lastIndex = index
      const match = raw.exec(source)
      if (!match) index++
      else {
        const closing = '"' + match[1]
        const end = source.indexOf(closing, raw.lastIndex)
        index = end < 0 ? source.length : end + closing.length
        hidden.push({ start, end: index })
      }
    } else if (source[index] === '"') {
      strings.push({
        start,
        interpolated: source.slice(Math.max(0, index - 2), index) === 's!',
        depth: 0,
      })
      index++
    } else if (source[index] === '«') {
      const end = source.indexOf('»', index + 1)
      index = end < 0 ? source.length : end + 1
      if (end < 0 || source.slice(start, index).includes('\n'))
        hidden.push({ start, end: index })
    } else if (
      source[index] === "'" &&
      !/[\p{L}\p{N}_']/u.test(source[index - 1] || '')
    ) {
      character.lastIndex = index
      const match = character.exec(source)
      index = match ? character.lastIndex : index + 1
      if (match) hidden.push({ start, end: index })
    } else if (string && source[index] === '{') {
      string.depth++
      index++
    } else if (string && source[index] === '}') {
      string.depth--
      index++
    } else index++
  }
  if (strings.length)
    hidden.push({ start: strings[0].start, end: source.length })
  hidden.sort((left, right) => left.start - right.start)
  const chunks = []
  let offset = 0
  for (const region of hidden) {
    if (region.end <= offset) continue
    const start = Math.max(offset, region.start)
    chunks.push(source.slice(offset, start))
    chunks.push(source.slice(start, region.end).replace(/[^\r\n]/g, ' '))
    offset = region.end
  }
  chunks.push(source.slice(offset))
  return { comments, code: chunks.join('') }
}

function leanModule(filename) {
  if (!filename.endsWith('.lean')) return null
  const segments = filename.slice(0, -5).split('/')
  if (segments.some((segment) => !segment || /[«»\r\n]/.test(segment)))
    return null
  return segments
    .map((segment) => (moduleSegment.test(segment) ? segment : `«${segment}»`))
    .join('.')
}

function texReferences(source, add) {
  const supported = new Set([
    'includegraphics',
    'input',
    'include',
    'bibliography',
    'addbibresource',
  ])
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '%' && !escaped(source, index)) {
      const end = source.indexOf('\n', index)
      index = end < 0 ? source.length : end
      continue
    }
    if (source[index] !== '\\' || escaped(source, index)) continue
    {
      const begin = /^\\begin\{(verbatim\*?|Verbatim|lstlisting|minted)\}/.exec(
        source.slice(index, index + 32),
      )
      if (begin) {
        const marker = `\\end{${begin[1]}}`
        const closing = source.indexOf(marker, index + begin[0].length)
        const boundary = closing < 0 ? source.length : closing + marker.length
        index = boundary - 1
        continue
      } else {
        const verb = /^\\verb\*?([^\w\s])/.exec(source.slice(index, index + 8))
        if (verb) {
          const closing = source.indexOf(verb[1], index + verb[0].length)
          const line = source.indexOf('\n', index)
          index =
            closing >= 0 && (line < 0 || closing < line)
              ? closing
              : line < 0
                ? source.length
                : line
          continue
        }
      }
    }
    let cursor = index + 1
    while (cursor < source.length && /[a-zA-Z]/.test(source[cursor])) cursor++
    const name = source.slice(index + 1, cursor)
    index = cursor - 1
    if (!supported.has(name)) continue
    if (name === 'includegraphics' && source[cursor] === '*') cursor++
    while (source[cursor] === ' ' || source[cursor] === '\t') cursor++
    while (source[cursor] === '[') {
      let depth = 1
      cursor++
      while (cursor < source.length && depth) {
        const char = source[cursor++]
        if (char === '\\') cursor++
        else if (char === '[') depth++
        else if (char === ']') depth--
        else if (char === '\r' || char === '\n')
          throw new ReferenceScanSkipped()
      }
      if (depth) throw new ReferenceScanSkipped()
      while (source[cursor] === ' ' || source[cursor] === '\t') cursor++
    }
    if (source[cursor] !== '{') {
      index = cursor - 1
      continue
    }
    const start = ++cursor
    let depth = 1,
      literal = true
    while (cursor < source.length && depth) {
      const char = source[cursor++]
      if (char === '\\') {
        literal = false
        cursor++
      } else if (char === '{') {
        literal = false
        depth++
      } else if (char === '}') depth--
      else if (char === '%' || char === '\r' || char === '\n')
        throw new ReferenceScanSkipped()
      else if (char === '#') literal = false
    }
    if (depth) throw new ReferenceScanSkipped()
    index = cursor - 1
    if (!literal) continue
    const extensions =
      name === 'includegraphics'
        ? ['.pdf', '.png', '.jpg', '.jpeg', '.svg', '.eps']
        : name === 'input' || name === 'include'
          ? ['.tex']
          : ['.bib']
    const value = source.slice(start, cursor - 1)
    const values = name === 'bibliography' ? value.split(',') : [value]
    let offset = start
    for (const value of values) {
      const leading = value.length - value.trimStart().length
      const trimmed = value.trim()
      if (trimmed)
        add(
          offset + leading,
          offset + leading + trimmed.length,
          trimmed,
          extensions,
        )
      offset += value.length + 1
    }
  }
}

/**
 * Prepare the known-file lookup once per move. Only recognized local references
 * are rewritten; strings, prose, remote URLs and ambiguous TeX paths stay intact.
 */
export function createReferenceRewriter({ from, to, moves, files }) {
  const known = new Set(files)
  const moved = createReferencePathMapper({ from, to, moves, files: known })
  const rewritePath = (value, filename, { angle = false, extensions } = {}) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null
    const boundary = extensions ? -1 : value.search(/[?#]/)
    const original = boundary < 0 ? value : value.slice(0, boundary)
    const suffix = boundary < 0 ? '' : value.slice(boundary)
    let decoded
    try {
      decoded = extensions ? original : decodeURIComponent(original)
    } catch {
      return null
    }
    if (!decoded || /[\\\0\r\n]/.test(decoded)) return null
    const workspace = decoded.startsWith('/workspace/')
    const rooted = decoded.startsWith('/')
    const relative = workspace ? decoded.slice('/workspace/'.length) : decoded
    const base = rooted ? '.' : path.posix.dirname(filename)
    const candidates = []
    const roots = extensions && !rooted && base !== '.' ? [base, '.'] : [base]
    for (const root of roots) {
      const target = normalized(root, relative)
      if (!target) continue
      if (known.has(target)) candidates.push({ target, root, omitted: false })
      else if (extensions && !path.posix.extname(relative))
        for (const extension of extensions)
          if (known.has(target + extension))
            candidates.push({ target: target + extension, root, omitted: true })
    }
    const distinct = new Set(candidates.map((candidate) => candidate.target))
    if (distinct.size !== 1) {
      if (
        candidates.some(
          (candidate) => moved(candidate.target) !== candidate.target,
        )
      )
        throw new ReferenceScanSkipped()
      return null
    }
    const selected = candidates[0]
    const nextFile = moved(filename)
    const nextTarget = moved(selected.target)
    if (nextFile === filename && nextTarget === selected.target) return null
    let next
    if (rooted) next = (workspace ? '/workspace/' : '/') + nextTarget
    else if (extensions && base !== '.' && selected.root === '.')
      next = nextTarget
    else next = path.posix.relative(path.posix.dirname(nextFile), nextTarget)
    if (selected.omitted && path.posix.extname(next))
      next = next.slice(0, -path.posix.extname(next).length)
    if (!rooted && original.startsWith('./') && !next.startsWith('.'))
      next = './' + next
    if (!extensions) {
      if (/%[0-9a-f]{2}/i.test(original))
        next = next
          .split('/')
          .map((segment) =>
            encodeURIComponent(segment).replace(
              /[!'()*]/g,
              (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
            ),
          )
          .join('/')
      else
        next = next.replace(
          angle ? /[%?#<>]/g : /[\s%?#()<>]/g,
          encodePathCharacter,
        )
    }
    return next + suffix === value ? null : next + suffix
  }
  return (content, filename) => {
    if (!isReferenceFile(filename)) return { content, count: 0 }
    if (
      /\.lean$/i.test(filename) &&
      !content.includes('import') &&
      !content.includes('[')
    )
      return { content, count: 0 }
    if (/\.tex$/i.test(filename) && !content.includes('\\'))
      return { content, count: 0 }
    const edits = []
    const link = (start, end, value, angle) => {
      const replacement = rewritePath(value, filename, { angle })
      if (replacement !== null) edits.push({ start, end, value: replacement })
    }
    try {
      if (/\.lean$/i.test(filename)) {
        const { comments, code } = leanRegions(content)
        for (const comment of comments)
          markdownReferences(
            content.slice(comment.start, comment.end),
            comment.start,
            link,
          )
        const imports =
          /^[ \t]*(?:(?:public|private|meta)[ \t]+)*import[ \t]+([^\r\n]*)/gm
        for (const statement of code.matchAll(imports)) {
          const start =
            statement.index + statement[0].length - statement[1].length
          moduleToken.lastIndex = 0
          for (const token of statement[1].matchAll(moduleToken)) {
            const end = token.index + token[0].length
            // An unsupported identifier may contain a supported-looking prefix
            // or suffix. Rewrite only an entire import, including quoted parts.
            if (
              (token.index > 0 && !/\s/.test(statement[1][token.index - 1])) ||
              (end < statement[1].length && !/\s/.test(statement[1][end]))
            )
              continue
            const segments = token[0].match(/«[^»\r\n]+»|[^.]+/g)
            const original =
              segments
                .map((segment) => segment.replace(/^«|»$/g, ''))
                .join('/') + '.lean'
            if (!known.has(original)) continue
            const next = moved(original)
            if (next === original) continue
            const replacement = leanModule(next)
            if (!replacement) throw new ReferenceScanSkipped()
            if (replacement && replacement !== token[0])
              edits.push({
                start: start + token.index,
                end: start + token.index + token[0].length,
                value: replacement,
              })
          }
        }
      } else if (/\.tex$/i.test(filename))
        texReferences(content, (start, end, value, extensions) => {
          const replacement = rewritePath(value, filename, { extensions })
          if (replacement !== null)
            edits.push({ start, end, value: replacement })
        })
      else markdownReferences(content, 0, link)
      return applyEdits(content, edits)
    } catch (error) {
      if (error instanceof ReferenceScanSkipped)
        return { content, count: 0, skipped: true }
      throw error
    }
  }
}

export function rewriteProjectReferences(content, { filename, ...move }) {
  return createReferenceRewriter(move)(content, filename)
}
