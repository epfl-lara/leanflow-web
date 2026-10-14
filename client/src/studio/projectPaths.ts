export function parentFolders(path: string): string[] {
  const parts = path.split('/')
  parts.pop()
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}
