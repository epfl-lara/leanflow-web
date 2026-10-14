import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, errorText, type LeanBook, type BookSearchResult } from './api'
import { bookPageUrl } from '../../../shared/lean-books.mjs'
import { Icon } from './Icons'
import './books.css'

export interface BookChatRequest {
  id: number
  projectId: string
  text: string
}

export function BooksPanel({
  open,
  canAsk,
  pageRequest,
  onClose,
  onAsk,
}: {
  open: boolean
  canAsk: boolean
  pageRequest?: { id: number; url: string } | null
  onClose: () => void
  onAsk: (text: string) => void
}) {
  const [books, setBooks] = useState<LeanBook[]>([])
  const [selected, setSelected] = useState('reference')
  const [url, setUrl] = useState(bookPageUrl('reference'))
  const [current, setCurrent] = useState({
    url,
    title: 'Lean Language Reference',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BookSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [navigationId, setNavigationId] = useState(0)
  const [chapterReady, setChapterReady] = useState(false)
  const requestedPage = useRef(pageRequest)
  requestedPage.current = pageRequest
  const catalogInitialized = useRef(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const search = useRef<AbortController | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const book = books.find((entry) => entry.id === selected)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void api<LeanBook[]>('/api/books', { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return
        setBooks(value)
        const available =
          value.find((entry) => entry.id === 'reference' && entry.available) ||
          value.find((entry) => entry.available)
        if (
          available &&
          !requestedPage.current &&
          !catalogInitialized.current
        ) {
          setSelected(available.id)
          setUrl(available.localUrl)
        }
        catalogInitialized.current = true
        setLoading(false)
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorText(failure))
          setLoading(false)
        }
      },
    )
    return () => {
      controller.abort()
      search.current?.abort()
    }
  }, [open])

  useEffect(() => {
    if (!pageRequest) return
    const match = /^\/api\/books\/([^/]+)\/content\//.exec(pageRequest.url)
    if (!match) return
    setSelected(match[1])
    search.current?.abort()
    setSearching(false)
    setResults(null)
    setChapterReady(false)
    setError('')
    setNavigationId((value) => value + 1)
    setUrl(pageRequest.url)
  }, [pageRequest])

  useEffect(() => {
    if (!open) return
    const restore = document.activeElement
    button.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('keydown', escape)
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [open, onClose])

  function navigate(next: string) {
    search.current?.abort()
    setSearching(false)
    setResults(null)
    setError('')
    setChapterReady(false)
    setNavigationId((value) => value + 1)
    setUrl(next)
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    search.current?.abort()
    const controller = new AbortController()
    search.current = controller
    setSearching(true)
    setError('')
    try {
      const value = await api<BookSearchResult[]>(
        `/api/books/search?q=${encodeURIComponent(query.trim())}&book=${encodeURIComponent(selected)}`,
        { signal: controller.signal },
      )
      if (!controller.signal.aborted) setResults(value)
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorText(failure))
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }
  }
  function loaded() {
    const document = frame.current?.contentDocument
    if (!document) {
      setChapterReady(false)
      setError(
        'This chapter could not be opened. Return to the book’s contents.',
      )
      return
    }
    const location = document.location
    const match = /^\/api\/books\/([^/]+)\/content\//.exec(location.pathname)
    if (
      !match ||
      !document.title ||
      !books.some((entry) => entry.id === match[1])
    ) {
      setChapterReady(false)
      setError(
        'This chapter could not be opened. Return to the book’s contents or sign in again.',
      )
      return
    }
    setSelected(match[1])
    setChapterReady(true)
    setError('')
    setCurrent({
      url: location.pathname + location.hash,
      title: document.title || book?.title || 'Lean book',
    })
    // Native book search needs upstream scripts; the panel supplies local search.
    for (const input of document.querySelectorAll(
      'input[type="search"], .search-box, #search-wrapper',
    )) {
      input.setAttribute('hidden', '')
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') onClose()
    })
    for (const anchor of document.querySelectorAll('a'))
      anchor.addEventListener('click', (event) => {
        const target = new URL(anchor.href, location.href)
        if (target.origin !== window.location.origin) return
        if (!/^\/api\/books\/[^/]+\/content\//.test(target.pathname)) {
          event.preventDefault()
          return
        }
        // Follow local chapters inside this frame, including links to another book.
        anchor.removeAttribute('target')
        if (target.pathname === location.pathname)
          setCurrent({
            url: target.pathname + target.hash,
            title: document.title,
          })
      })
  }

  return (
    <section
      className={`books-panel ${expanded ? 'expanded' : ''}`}
      aria-label="Lean docs"
      hidden={!open}
    >
      <header className="books-header">
        <div>
          <Icon name="book" size={17} />
          <strong>Lean docs</strong>
          <span className="tag">Local</span>
        </div>
        <div>
          <button
            className="button small subtle"
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Split view' : 'Expand'}
          </button>
          <button
            ref={button}
            className="icon-button"
            aria-label="Close Lean docs"
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>
      <div className="books-controls">
        <label className="sr-only" htmlFor="lean-book-select">
          Choose a book
        </label>
        <select
          id="lean-book-select"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value)
            setQuery('')
            navigate(bookPageUrl(event.target.value))
          }}
        >
          {books.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.title}
              {entry.available ? '' : ' · Not installed'}
            </option>
          ))}
        </select>
        <form onSubmit={(event) => void submit(event)}>
          <Icon name="search" size={15} />
          <input
            aria-label="Search this book"
            type="search"
            placeholder="Search this book…"
            value={query}
            onChange={(event) => {
              search.current?.abort()
              setSearching(false)
              setQuery(event.target.value)
            }}
            maxLength={160}
          />
          <button
            className="button small subtle"
            disabled={!book?.available || searching || query.trim().length < 2}
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
        <div className="books-actions">
          <button
            className="button small subtle"
            disabled={!book?.available}
            onClick={() => navigate(bookPageUrl(selected))}
          >
            Contents
          </button>
          <span className="books-version">
            {book?.leanVersion
              ? `Lean ${book.leanVersion}`
              : 'Documentation snapshot'}
          </span>
          <button
            className="button small secondary"
            disabled={
              !canAsk || !book?.available || !chapterReady || results !== null
            }
            title={
              canAsk
                ? 'Add this chapter to your Lemex message'
                : 'Open a prepared project to ask Lemex'
            }
            onClick={() => {
              if (!book || !chapterReady) return
              const selection = frame.current?.contentWindow
                ?.getSelection()
                ?.toString()
                .trim()
                .slice(0, 4000)
              onAsk(
                `Please explain ${selection ? 'this passage' : 'this chapter'} from ${book.title}: ${current.title}\nLocal chapter: ${current.url}\n${selection ? `\nSelected passage:\n${selection}\n` : ''}`,
              )
            }}
          >
            <Icon name="bot" size={14} />
            Ask Lemex
          </button>
        </div>
      </div>
      {error && (
        <p className="books-notice error-message" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <output className="books-notice">Loading local books…</output>
      ) : !book?.available ? (
        <p className="books-notice">
          This book has not been installed. Ask the server administrator to
          install the local Lean books.
        </p>
      ) : null}
      {results !== null && (
        <div className="books-results" aria-label="Book search results">
          <div className="books-result-caption">
            <span>
              {results.length
                ? `${results.length} matching chapters`
                : 'No matching chapters. Try another phrase.'}
            </span>
            <button
              className="button small subtle"
              onClick={() => setResults(null)}
            >
              Return to reading
            </button>
          </div>
          {results.map((result) => (
            <button key={result.url} onClick={() => navigate(result.url)}>
              <strong>{result.title}</strong>
              <span>{result.excerpt}</span>
            </button>
          ))}
        </div>
      )}
      {book?.available && (
        <iframe
          key={navigationId}
          ref={frame}
          title="Local Lean book"
          src={url}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          onLoad={loaded}
          hidden={results !== null}
        />
      )}
    </section>
  )
}
