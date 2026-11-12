import {
  MAX_IMAGE_FILE_BYTES,
  isRasterImageFile,
  isPdfFile,
} from '../shared/file-previews.mjs'
import { decodePdfUpload, validatePdfBytes } from './pdf-preview.mjs'
import { validateImageBytes } from './image-preview.mjs'

const fail = (message, status = 415) => {
  throw Object.assign(new Error(message), { status })
}

export function validateBinaryAsset(filename, bytes) {
  if (isPdfFile(filename)) return validatePdfBytes(filename, bytes)
  if (!isRasterImageFile(filename))
    fail(
      'Upload a PDF or supported raster image as binary data. Upload SVG as text.',
    )
  if (bytes.length > MAX_IMAGE_FILE_BYTES)
    fail(
      'Images must be at most 16 MiB. Reduce the image and upload it again.',
      413,
    )
  return validateImageBytes(filename, bytes)
}

export function decodeBinaryAsset(filename, content) {
  if (isPdfFile(filename)) return decodePdfUpload(filename, content)
  if (!isRasterImageFile(filename))
    fail(
      'Only PDF or supported raster images can be uploaded as binary data. Upload SVG as text.',
    )
  if (content.length > Math.ceil(MAX_IMAGE_FILE_BYTES / 3) * 4)
    fail('Images must be at most 16 MiB.', 413)
  if (content.length % 4 || /[^A-Za-z0-9+/=]/.test(content))
    fail(`Invalid image upload encoding: ${filename}. Choose the image again.`)
  const bytes = Buffer.from(content, 'base64')
  if (bytes.toString('base64') !== content)
    fail(`Invalid image upload encoding: ${filename}. Choose the image again.`)
  return validateBinaryAsset(filename, bytes)
}
