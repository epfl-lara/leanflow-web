export const LEAN_BOOKS = [
  {
    id: 'functional-programming',
    title: 'Functional Programming in Lean',
    url: 'https://lean-lang.org/functional_programming_in_lean/',
  },
  {
    id: 'theorem-proving',
    title: 'Theorem Proving in Lean 4',
    url: 'https://lean-lang.org/theorem_proving_in_lean4/',
  },
  {
    id: 'reference',
    title: 'Lean Language Reference',
    url: 'https://lean-lang.org/doc/reference/latest/',
  },
]

export function bookPageUrl(id, page = '') {
  return `/api/books/${encodeURIComponent(id)}/content/${page
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

export function localBookLink(value, base) {
  let url
  try {
    url = new URL(value, base)
    url.pathname = url.pathname.replace(/\/{2,}/g, '/')
  } catch {
    return null
  }
  const book = LEAN_BOOKS.find((entry) => url.href.startsWith(entry.url))
  if (!book) return null
  try {
    return {
      id: book.id,
      page: decodeURIComponent(
        url.pathname.slice(new URL(book.url).pathname.length),
      ),
      hash: url.hash,
    }
  } catch {
    return null
  }
}
