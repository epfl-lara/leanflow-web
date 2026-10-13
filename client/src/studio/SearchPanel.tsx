import { useState, type FormEvent } from 'react'
import { errorText, post, pretty } from './api'
import { Icon } from './Icons'

interface SearchResponse {
  results?: unknown
  error?: string
  [key: string]: unknown
}
function Result({ value }: { value: unknown }) {
  if (typeof value === 'string')
    return <pre className="search-output">{value}</pre>
  if (!value || typeof value !== 'object')
    return <pre className="search-output">{pretty(value)}</pre>
  const item = value as Record<string, unknown>
  const name = item.name || item.declaration || item.title || item.fullName
  const description =
    item.type || item.signature || item.description || item.docstring
  const documentation = item.doc || item.docstring || item.documentation
  const module = item.module || item.source_file
  const rawUrl = item.url || item.link
  const url =
    typeof rawUrl === 'string' && /^https?:\/\//.test(rawUrl) ? rawUrl : null
  return (
    <article className="search-result">
      {!!name && <strong>{String(name)}</strong>}
      {!!description && <pre>{pretty(description)}</pre>}
      {!!documentation && <p className="field-help">{pretty(documentation)}</p>}
      {!!module && <p className="field-help">{String(module)}</p>}
      {!name && !description && <pre>{pretty(item)}</pre>}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer">
          Open source <Icon name="external" size={13} />
        </a>
      )}
    </article>
  )
}

export function SearchPanel({ projectId }: { projectId?: string }) {
  const [backend, setBackend] = useState<'loogle' | 'leanexplore'>('loogle')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [response, setResponse] = useState<SearchResponse | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setResponse(null)
    try {
      const result = await post<SearchResponse>('/api/search', {
        query,
        backend,
        projectId,
      })
      if (result.error) setError(result.error)
      else setResponse(result)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
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
          Search by a type pattern with Loogle, or describe what you need with
          LeanExplore.
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
          <option value="loogle">Loogle · type patterns</option>
          <option value="leanexplore">LeanExplore · semantic search</option>
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
        <button className="button primary" disabled={busy || !query.trim()}>
          {busy ? (
            <span className="spinner" />
          ) : (
            <Icon name="search" size={16} />
          )}
          {busy ? 'Searching…' : 'Search declarations'}
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
              results.map((item, index) => <Result key={index} value={item} />)
            ) : (
              <p className="field-help">
                No declarations matched. Try a broader query.
              </p>
            )
          ) : (
            <Result value={results ?? response} />
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
