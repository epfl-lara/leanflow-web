import type {} from 'remark-parse'
import type { Extension as MarkdownExtension } from 'mdast-util-from-markdown'
import type { Code, Extension, State, Tokenizer } from 'micromark-util-types'
import type { Processor } from 'unified'

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    latexMath: 'latexMath'
    latexMathData: 'latexMathData'
  }
}

// Recognize LaTeX delimiters during Markdown parsing, so code, links, escaped
// backslashes and existing dollar-delimited math retain their original meaning.
const tokenize: Tokenizer = function (effects, ok, nok) {
  let closing = 0
  return start

  function start(code: Code): State | undefined {
    effects.enter('latexMath')
    effects.enter('latexMathData')
    effects.consume(code)
    return opening
  }

  function opening(code: Code): State | undefined {
    if (code !== 40 && code !== 91) return nok(code)
    closing = code === 40 ? 41 : 93
    effects.consume(code)
    return content
  }

  function content(code: Code): State | undefined {
    if (code === null) return nok(code)
    if (code === -3 || code === -4 || code === -5) {
      effects.exit('latexMathData')
      effects.enter('lineEnding')
      effects.consume(code)
      effects.exit('lineEnding')
      return nextLine
    }
    effects.consume(code)
    return code === 92 ? afterBackslash : content
  }

  function nextLine(code: Code): State | undefined {
    effects.enter('latexMathData')
    return content(code)
  }

  function afterBackslash(code: Code): State | undefined {
    if (code === null) return nok(code)
    if (code === -3 || code === -4 || code === -5) return content(code)
    effects.consume(code)
    if (code !== closing) return content
    effects.exit('latexMathData')
    effects.exit('latexMath')
    return ok
  }
}

const syntax: Extension = {
  text: { 92: { name: 'latexMath', tokenize } },
}

const fromMarkdown: MarkdownExtension = {
  enter: {
    latexMath(token) {
      this.enter({ type: 'inlineMath', value: '' }, token)
      this.buffer()
    },
  },
  exit: {
    latexMath(token) {
      this.resume()
      const node = this.stack.at(-1)
      if (node?.type !== 'inlineMath') return
      const source = this.sliceSerialize(token)
      node.value = source.slice(2, -2)
      node.data = {
        hName: 'span',
        hProperties: {
          className: [
            'language-math',
            source.startsWith('\\[') ? 'math-display' : 'math-inline',
          ],
        },
        hChildren: [{ type: 'text', value: node.value }],
      }
      this.exit(token)
    },
  },
}

export function remarkLatexMath(this: Processor) {
  const data = this.data()
  const syntaxExtensions =
    data.micromarkExtensions || (data.micromarkExtensions = [])
  const markdownExtensions =
    data.fromMarkdownExtensions || (data.fromMarkdownExtensions = [])
  syntaxExtensions.push(syntax)
  markdownExtensions.push(fromMarkdown)
}
