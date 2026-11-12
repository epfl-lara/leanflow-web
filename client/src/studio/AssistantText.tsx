import {
  memo,
  useContext,
  useDeferredValue,
  useMemo,
  useRef,
  useLayoutEffect,
  type ComponentPropsWithoutRef,
} from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { remarkLatexMath } from './remarkLatexMath'
import { Icon } from './Icons'
import { MarkdownCodeBlock } from './CodeBlock'
import {
  MarkdownProjectImage,
  MarkdownImageLinkContext,
} from './MarkdownProjectImage'
import { markdownImagePath } from './markdownImagePath'
import './markdownImages.css'
import 'katex/dist/katex.min.css'

function MarkdownLink({
  node: _node,
  href,
  children,
  onOpenLocalLink,
  ...props
}: ComponentPropsWithoutRef<'a'> &
  ExtraProps & { onOpenLocalLink?: (href: string) => void }) {
  const external = /^(?:https?:)?\/\//i.test(href || '')
  return (
    <MarkdownImageLinkContext.Provider value={true}>
      <a
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        onClick={(event) => {
          if (
            href &&
            onOpenLocalLink &&
            !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)
          ) {
            event.preventDefault()
            onOpenLocalLink(href)
          }
        }}
      >
        {children}
      </a>
    </MarkdownImageLinkContext.Provider>
  )
}

function MarkdownImageLink({
  src,
  alt,
}: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const linked = useContext(MarkdownImageLinkContext)
  if (linked) return <span>{alt ? `Image: ${alt}` : 'Image'}</span>
  return typeof src === 'string' && src ? (
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
  )
}

const markdownComponents: Components = {
  pre: MarkdownCodeBlock,
  table: ({ node: _node, children, ...props }) => (
    <div className="markdown-table">
      <table {...props}>{children}</table>
    </div>
  ),
  a: MarkdownLink,
  // Keep remote images as deliberate links rather than loading third-party
  // resources automatically while a model response is streamed.
  img: MarkdownImageLink,
}

const MarkdownText = memo(function MarkdownText({
  text,
  onOpenLocalLink,
  projectId,
  currentPath,
}: {
  text: string
  onOpenLocalLink?: (href: string) => void
  projectId?: string
  currentPath?: string
}) {
  // Stable renderer identities keep images mounted while a reply streams.
  const openLocalLink = useRef(onOpenLocalLink)
  const hasLocalLink = !!onOpenLocalLink
  useLayoutEffect(() => {
    openLocalLink.current = onOpenLocalLink
  }, [onOpenLocalLink])
  const components = useMemo<Components>(
    () => ({
      ...markdownComponents,
      a: (props) => (
        <MarkdownLink
          {...props}
          onOpenLocalLink={
            hasLocalLink ? (href) => openLocalLink.current?.(href) : undefined
          }
        />
      ),
      img: (props) => {
        const source = typeof props.src === 'string' ? props.src : null
        const path =
          source && projectId ? markdownImagePath(source, currentPath) : null
        return path && projectId ? (
          <MarkdownProjectImage
            projectId={projectId}
            path={path}
            alt={props.alt}
            onOpen={
              hasLocalLink && source
                ? () => openLocalLink.current?.(source)
                : undefined
            }
          />
        ) : (
          <MarkdownImageLink {...props} />
        )
      },
    }),
    [currentPath, hasLocalLink, projectId],
  )
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
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
})

export const OutputText = memo(function OutputText({
  text,
  streaming = false,
  onOpenLocalLink,
  projectId,
  currentPath,
}: {
  text: string
  streaming?: boolean
  onOpenLocalLink?: (href: string) => void
  projectId?: string
  currentPath?: string
}) {
  // Memoizing the parser lets editing and follow-ups take priority while the
  // deferred output catches up, without reparsing the previous text twice.
  const deferredText = useDeferredValue(text)
  const markdown = (
    <MarkdownText
      text={streaming ? deferredText : text}
      onOpenLocalLink={onOpenLocalLink}
      projectId={projectId}
      currentPath={currentPath}
    />
  )
  return (
    <div
      className={streaming ? 'streaming-text markdown-body' : 'markdown-body'}
    >
      {markdown}
    </div>
  )
})
