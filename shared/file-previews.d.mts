export const MAX_PDF_FILE_BYTES: number
export function isPdfFile(filename: unknown): boolean
export const MAX_IMAGE_FILE_BYTES: number
export const MAX_IMAGE_PIXELS: number
export const MAX_SVG_PREVIEW_BYTES: number
export const MAX_HTML_PREVIEW_BYTES: number
export function imageMimeType(filename: unknown): string | null
export function isImageFile(filename: unknown): boolean
export function isSvgFile(filename: unknown): boolean
export function isRasterImageFile(filename: unknown): boolean
export function isHtmlFile(filename: unknown): boolean
export function isBinaryAssetFile(filename: unknown): boolean
