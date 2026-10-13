import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, errorText } from './api'
import { OutputText } from './AssistantText'
import { Icon } from './Icons'
import type { SourceRequest } from './LibrarySourceDialog'
import './search-results.css'

interface SearchResponse {
  results?: unknown
  error?: string
  [key: string]: unknown
}
function resultText(...values: unknown[]) {
  return values.find((value) => typeof value === 'string' && value.trim()) as
    | string
    | undefined
}

function sourceUrl(value: unknown) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

function Result({
  value,
  onOpenLocal,
}: {
  value: unknown
  onOpenLocal?: (request: SourceRequest) => void
}) {
  const item =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const name = resultText(
    item.name,
    item.declaration,
    item.title,
    item.fullName,
  )
  const type = resultText(item.type)
  const signature = type || resultText(item.signature, item.statement)
  const kind = resultText(item.kind)
  const documentation = resultText(
    item.doc,
    item.docstring,
    item.documentation,
    item.description,
    typeof value === 'string' ? value : undefined,
  )
  const module = resultText(item.module, item.source_file)
  const url = sourceUrl(item.url || item.link)
  const localSignature = resultText(item.signature) || ''
  return (
    <article className="search-result">
      <header className="search-result-heading">
        <strong>{name || 'Declaration'}</strong>
        {kind && <span className="search-kind">{kind}</span>}
      </header>
      <div className="search-signature">
        <span className="search-result-label">
          {type || !signature ? 'Type' : 'Signature'}
        </span>
        {signature ? (
          <pre className="search-type">
            <code>{signature}</code>
          </pre>
        ) : (
          <p className="search-type-unavailable">
            Type unavailable from this search service.
          </p>
        )}
      </div>
      {documentation && (
        <div className="search-documentation">
          <span className="search-result-label">Documentation</span>
          <div className="markdown-body search-documentation-body">
            <OutputText text={documentation} />
          </div>
        </div>
      )}
      {module && (
        <p className="search-module">
          <span className="search-result-label">Module</span>
          <code>{module}</code>
        </p>
      )}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer">
          Open source <Icon name="external" size={13} />
        </a>
      )}
      {module && onOpenLocal && (
        <button
          className="button secondary search-open-local"
          onClick={() =>
            onOpenLocal({
              module,
              signature: localSignature.length <= 16_000 ? localSignature : '',
            })
          }
        >
          Open locally
        </button>
      )}
    </article>
  )
}

export function SearchPanel({
  projectId,
  onOpenSource,
}: {
  projectId?: string
  onOpenSource: (request: SourceRequest) => void
}) {
  const [backend, setBackend] = useState<'loogle' | 'leanexplore'>(
    'leanexplore',
  )
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [pendingQuery, setPendingQuery] = useState('')
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)

  // A hosted index response belongs to the engine and project that requested it.
  useEffect(() => {
    generation.current += 1
    controller.current?.abort()
    setResponse(null)
    setError('')
    setBusy(false)
    return () => {
      generation.current += 1
      controller.current?.abort()
    }
  }, [backend, projectId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!query.trim()) return
    const request = ++generation.current
    controller.current?.abort()
    const currentController = new AbortController()
    controller.current = currentController
    setBusy(true)
    setPendingQuery(query.trim())
    setError('')
    setResponse(null)
    try {
      const result = await api<SearchResponse>('/api/search', {
        method: 'POST',
        body: JSON.stringify({ query: query.trim(), backend, projectId }),
        signal: currentController.signal,
      })
      if (request !== generation.current) return
      if (result.error) setError(result.error)
      else setResponse(result)
    } catch (error) {
      if (request === generation.current) setError(errorText(error))
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  const results = response?.results
  const source = response?.source as
    | { name?: string; version?: string; workspaceToolchain?: string }
    | undefined
  return (
    <div className="search-panel">
      <div className="panel-intro">
        <h2>Find a declaration</h2>
        <p>
          Describe what you need with LeanExplore, or search by a type pattern
          with Loogle.
        </p>
      </div>
      <form onSubmit={submit} className="search-form">
        <label className="field-label" htmlFor="search-backend">
          Search engine
        </label>
        <select
          id="search-backend"
          value={backend}
          onChange={(event) => setBackend(event.target.value as typeof backend)}
        >
          <option value="leanexplore">LeanExplore · semantic search</option>
          <option value="loogle">Loogle · type patterns</option>
        </select>
        <label className="field-label" htmlFor="declaration-query">
          {backend === 'loogle'
            ? 'Type pattern or declaration name'
            : 'What are you looking for?'}
        </label>
        <textarea
          id="declaration-query"
          rows={3}
          placeholder={
            backend === 'loogle'
              ? 'List.map, (_ → _)'
              : 'A theorem about convergence of a bounded monotone sequence'
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          required
        />
        <button
          className="button primary"
          disabled={!query.trim() || (busy && query.trim() === pendingQuery)}
        >
          {busy && query.trim() === pendingQuery ? (
            <span className="spinner" />
          ) : (
            <Icon name="search" size={16} />
          )}
          {busy && query.trim() === pendingQuery
            ? 'Searching…'
            : 'Search declarations'}
        </button>
      </form>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {response && (
        <div className="search-results" aria-live="polite">
          {source && (
            <p className="field-help">
              {source.name} · {source.version || 'Hosted index'}
              {source.workspaceToolchain && (
                <>
                  <br />
                  Project:{' '}
                  {source.workspaceToolchain.replace(
                    'leanprover/lean4:',
                    'Lean ',
                  )}
                  . Check declarations in this version.
                </>
              )}
            </p>
          )}
          {Array.isArray(results) ? (
            results.length ? (
              results.map((item, index) => (
                <Result
                  key={index}
                  value={item}
                  onOpenLocal={projectId ? onOpenSource : undefined}
                />
              ))
            ) : (
              <p className="field-help">
                No declarations matched. Try a broader query.
              </p>
            )
          ) : (
            <Result
              value={results ?? response}
              onOpenLocal={projectId ? onOpenSource : undefined}
            />
          )}
        </div>
      )}
      {!response && !busy && !error && (
        <div className="quiet-note">
          <Icon name="search" size={26} />
          <p>
            Results are checked in your project when you use them in a proof.
          </p>
        </div>
      )}
    </div>
  )
}
