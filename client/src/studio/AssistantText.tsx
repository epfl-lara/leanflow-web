import { memo, useDeferredValue } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { remarkLatexMath } from './remarkLatexMath'
import { Icon } from './Icons'
import 'katex/dist/katex.min.css'

const markdownComponents: Components = {
  table: ({ node: _node, children, ...props }) => (
    <div className="markdown-table">
      <table {...props}>{children}</table>
    </div>
  ),
  a: ({ node: _node, href, children, ...props }) => {
    const external = /^(?:https?:)?\/\//i.test(href || '')
    return (
      <a
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    )
  },
  // Keep remote images as deliberate links rather than loading third-party
  // resources automatically while a model response is streamed.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-image-link"
      >
        {alt ? `Image: ${alt}` : 'Open image'}
        <Icon name="external" size={12} />
      </a>
    ) : (
      <span>{alt ? `Image: ${alt}` : 'Image'}</span>
    ),
}

const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm, remarkMath, remarkLatexMath]}
      rehypePlugins={[
        [
          rehypeKatex,
          { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 },
        ],
      ]}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  )
})

export const OutputText = memo(function OutputText({
  text,
  streaming = false,
}: {
  text: string
  streaming?: boolean
}) {
  // Memoizing the parser lets editing and follow-ups take priority while the
  // deferred output catches up, without reparsing the previous text twice.
  const deferredText = useDeferredValue(text)
  const markdown = <MarkdownText text={streaming ? deferredText : text} />
  return streaming ? (
    <div className="streaming-text markdown-body">{markdown}</div>
  ) : (
    markdown
  )
})
