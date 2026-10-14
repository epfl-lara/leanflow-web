export function playgroundDownloadName(name: string) {
  const value = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return value
    ? value.endsWith('.lean')
      ? value
      : `${value}.lean`
    : 'Scratch.lean'
}
