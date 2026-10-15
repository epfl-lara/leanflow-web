export const TEX_ENGINES = ['pdflatex']
export const TEX_SOURCE_MAX_BYTES = 64 * 1024 * 1024
export const TEX_SOURCE_MAX_FILES = 4096
export const TEX_FILE_MAX_BYTES = 16 * 1024 * 1024

export function isTexFile(filename) {
  return typeof filename === 'string' && /\.tex$/i.test(filename)
}

export function safeTexPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || part.startsWith('.'),
      )
  )
    throw Object.assign(
      new Error('Choose a relative TeX file inside this project.'),
      { status: 400 },
    )
  return value
}

export function isTexInputFile(filename) {
  return /\.(?:tex|ltx|tikz|pgf|bbl|sty|cls|bib|bst|cfg|def|clo|fd|ldf|bbx|cbx|lbx|ist|txt|csv|tsv|dat|pdf|png|jpe?g)$/i.test(
    filename,
  )
}
