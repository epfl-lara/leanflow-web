export async function searchDeclarations({ query, backend, projectId }, owner, workspaces) {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw Object.assign(new Error('Enter a search query of up to 2,000 characters.'), { status: 400 })
  if (!['loogle', 'leanexplore'].includes(backend)) throw Object.assign(new Error('Choose Loogle or LeanExplore.'), { status: 400 })
  const project = projectId ? workspaces.get(projectId, owner) : null
  const endpoint = backend === 'loogle' ? 'https://loogle.lean-lang.org/json' : 'https://www.leanexplore.com/api/v2/search'
  const url = new URL(endpoint)
  url.searchParams.set('q', query.trim())
  if (backend === 'leanexplore') url.searchParams.set('limit', '12')
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', 'user-agent': 'LemexWeb/0.1' } })
  if (!response.ok) throw Object.assign(new Error(`${backend === 'loogle' ? 'Loogle' : 'LeanExplore'} is unavailable (HTTP ${response.status}). Try again later or use the other search service.`), { status: 502 })
  const text = await response.text()
  if (text.length > 2_000_000) throw new Error('Search response exceeded the size limit.')
  const data = JSON.parse(text)
  if (data.error) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error)), { status: 400 })
  const hits = (data.hits || data.results || []).slice(0, 30)
  return {
    query, backend, count: data.count ?? hits.length,
    source: { name: backend === 'loogle' ? 'Loogle' : 'LeanExplore', url: endpoint, version: 'Hosted index', workspaceToolchain: project?.toolchain || null },
    results: hits.map(hit => ({
      ...hit,
      name: hit.name || hit.declaration_name || hit.primary_declaration || hit.declarationName || `Declaration ${hit.id || ''}`,
      type: hit.type || hit.signature || hit.statement || hit.declaration_text || '',
      doc: hit.doc || hit.docstring || hit.documentation || '',
      module: hit.module || hit.module_name || hit.source_file || hit.file_path || '',
      url: hit.url || hit.source_url || null,
    })),
  }
}
