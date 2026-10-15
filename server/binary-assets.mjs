import {
  MAX_IMAGE_FILE_BYTES,
  isImageFile,
  isPdfFile,
} from '../shared/file-previews.mjs'
import { decodePdfUpload, validatePdfBytes } from './pdf-preview.mjs'

const fail = (message, status = 415) => {
  throw Object.assign(new Error(message), { status })
}

export function validateBinaryAsset(filename, bytes) {
  if (isPdfFile(filename)) return validatePdfBytes(filename, bytes)
  if (!isImageFile(filename)) fail('Upload PDF, PNG, or JPEG binary assets.')
  if (bytes.length > MAX_IMAGE_FILE_BYTES)
    fail(
      'Images must be at most 16 MiB. Reduce the image and upload it again.',
      413,
    )
  const png = /\.png$/i.test(filename)
  const valid = png
    ? bytes.length >= 20 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes
        .subarray(-12)
        .equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
    : bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes.at(-2) === 255 &&
      bytes.at(-1) === 217
  if (!valid)
    fail(
      'This file is not a complete PNG or JPEG. Export it again before uploading.',
    )
  return bytes
}

export function decodeBinaryAsset(filename, content) {
  if (isPdfFile(filename)) return decodePdfUpload(filename, content)
  if (!isImageFile(filename))
    fail('Only PDF, PNG, or JPEG files can be uploaded as binary data.')
  if (content.length > Math.ceil(MAX_IMAGE_FILE_BYTES / 3) * 4)
    fail('Images must be at most 16 MiB.', 413)
  if (content.length % 4 || /[^A-Za-z0-9+/=]/.test(content))
    fail(`Invalid image upload encoding: ${filename}. Choose the image again.`)
  const bytes = Buffer.from(content, 'base64')
  if (bytes.toString('base64') !== content)
    fail(`Invalid image upload encoding: ${filename}. Choose the image again.`)
  return validateBinaryAsset(filename, bytes)
}
