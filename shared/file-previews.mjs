export const MAX_PDF_FILE_BYTES = 16 * 1024 * 1024

export function isPdfFile(filename) {
  return typeof filename === 'string' && /\.pdf$/i.test(filename)
}

export const MAX_IMAGE_FILE_BYTES = 16 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40 * 1024 * 1024
export const MAX_SVG_PREVIEW_BYTES = 2 * 1024 * 1024
export const MAX_HTML_PREVIEW_BYTES = 2 * 1024 * 1024

const imageTypes = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
})

export function imageMimeType(filename) {
  if (typeof filename !== 'string') return null
  const extension = filename.split('.').at(-1)?.toLowerCase()
  return Object.hasOwn(imageTypes, extension) ? imageTypes[extension] : null
}

export function isImageFile(filename) {
  return imageMimeType(filename) !== null
}

export function isSvgFile(filename) {
  return typeof filename === 'string' && /\.svg$/i.test(filename)
}

export function isRasterImageFile(filename) {
  return isImageFile(filename) && !isSvgFile(filename)
}

export function isHtmlFile(filename) {
  return typeof filename === 'string' && /\.(?:html?|xhtml)$/i.test(filename)
}

export function isBinaryAssetFile(filename) {
  return isPdfFile(filename) || isRasterImageFile(filename)
}
