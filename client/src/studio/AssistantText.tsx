import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from './Icons'

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

export const OutputText = memo(function OutputText({
  text,
  streaming = false,
}: {
  text: string
  streaming?: boolean
}) {
  if (streaming) return <div className="streaming-text">{text}</div>
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  )
})
