export const MAX_PDF_FILE_BYTES = 16 * 1024 * 1024

export function isPdfFile(filename) {
  return typeof filename === 'string' && /\.pdf$/i.test(filename)
}
