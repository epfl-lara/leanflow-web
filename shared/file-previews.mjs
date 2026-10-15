export const MAX_PDF_FILE_BYTES = 16 * 1024 * 1024

export function isPdfFile(filename) {
  return typeof filename === 'string' && /\.pdf$/i.test(filename)
}

export const MAX_IMAGE_FILE_BYTES = 16 * 1024 * 1024

export function isImageFile(filename) {
  return typeof filename === 'string' && /\.(?:png|jpe?g)$/i.test(filename)
}

export function isBinaryAssetFile(filename) {
  return isPdfFile(filename) || isImageFile(filename)
}
