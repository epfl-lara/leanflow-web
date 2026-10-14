export interface LeanBookDefinition {
  id: string
  title: string
  url: string
}
export const LEAN_BOOKS: LeanBookDefinition[]
export function bookPageUrl(id: string, page?: string): string
export function localBookLink(
  value: string,
  base: string,
): {
  id: string
  page: string
  hash: string
} | null
