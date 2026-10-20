/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Code previews must be keyboard-scrollable. */
import { memo, useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import type { ExtraProps } from 'react-markdown'
import { CopyButton } from './CopyButton'
import { codeTokens } from './codeTokens'

const labels: Record<string, string> = {
  lean: 'Lean',
  lean4: 'Lean',
  diff: 'Diff',
  patch: 'Diff',
  bash: 'Shell',
  sh: 'Shell',
  shell: 'Shell',
  console: 'Terminal',
  json: 'JSON',
  python: 'Python',
  py: 'Python',
  latex: 'LaTeX',
  tex: 'LaTeX',
  markdown: 'Markdown',
  md: 'Markdown',
  typescript: 'TypeScript',
  ts: 'TypeScript',
  javascript: 'JavaScript',
  js: 'JavaScript',
  text: 'Text',
  plaintext: 'Text',
}

export const CodeBlock = memo(function CodeBlock({
  text,
  language = '',
}: {
  text: string
  language?: string
}) {
  const [wrap, setWrap] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lang = language.toLowerCase()
  const tokens = useMemo(() => codeTokens(text, lang), [text, lang])
  const lines = useMemo(
    () => text.replace(/\n$/, '').split('\n').length,
    [text],
  )
  const label =
    (Object.hasOwn(labels, lang) ? labels[lang] : language) || 'Code'
  return (
    <figure className={`code-block ${wrap ? 'code-wrap' : ''}`}>
      <figcaption className="code-block-header">
        <span className="code-language">{label}</span>
        {lines > 1 && <span className="code-line-count">{lines} lines</span>}
        <span className="code-block-actions">
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            Wrap
          </button>
          <CopyButton text={text} label="Copy code" />
        </span>
      </figcaption>
      <pre
        className={expanded ? 'code-expanded' : ''}
        tabIndex={0}
        aria-label={`${label} code`}
      >
        <code>
          {tokens.map((token, index) =>
            token.kind ? (
              <span key={index} className={`syntax-${token.kind}`}>
                {token.text}
              </span>
            ) : (
              token.text
            ),
          )}
        </code>
      </pre>
      {lines > 18 && (
        <button
          type="button"
          className="code-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Collapse code' : `Expand all ${lines} lines`}
        </button>
      )}
    </figure>
  )
})

export function MarkdownCodeBlock({
  node,
  children,
  ...props
}: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const code = node?.children[0]
  if (code?.type !== 'element' || code.tagName !== 'code')
    return <pre {...props}>{children}</pre>
  const text = code.children
    .map((child) => (child.type === 'text' ? child.value : ''))
    .join('')
  const classes = Array.isArray(code.properties.className)
    ? code.properties.className
    : []
  const language = String(
    classes.find((value) => String(value).startsWith('language-')) || '',
  ).slice(9)
  return <CodeBlock text={text} language={language} />
}
