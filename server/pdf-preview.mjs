import path from 'node:path'
import { MAX_PDF_FILE_BYTES, isPdfFile } from '../shared/file-previews.mjs'

const fail = (message, status = 415) => {
  throw Object.assign(new Error(message), { status })
}

export function validatePdfBytes(filename, content) {
  if (!isPdfFile(filename)) fail('Choose a .pdf file to preview.')
  if (content.length > MAX_PDF_FILE_BYTES)
    fail(
      'PDF files must be at most 16 MiB. Reduce the PDF and upload it again.',
      413,
    )
  // Parsing and rendering happen in the reader. Reject obvious mismatches and
  // incomplete uploads here without interpreting document actions or links.
  if (
    !/^%PDF-\d\.\d[\r\n]/.test(content.subarray(0, 16).toString('latin1')) ||
    !/%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.test(
      content.subarray(-1024).toString('latin1'),
    )
  )
    fail(
      'This file is not a complete PDF. Export it as PDF and upload it again.',
    )
  return content
}

export function decodePdfUpload(filename, content) {
  if (!isPdfFile(filename))
    fail('Only .pdf files can be uploaded as binary data.')
  if (content.length > Math.ceil(MAX_PDF_FILE_BYTES / 3) * 4)
    fail(
      'PDF files must be at most 16 MiB. Reduce the PDF and upload it again.',
      413,
    )
  // Buffer.from accepts malformed and noncanonical base64, so validate before
  // decoding and compare its canonical representation afterwards.
  if (content.length % 4 || /[^A-Za-z0-9+/=]/.test(content))
    fail(`Invalid PDF upload encoding: ${filename}. Choose the PDF again.`)
  const bytes = Buffer.from(content, 'base64')
  if (bytes.toString('base64') !== content)
    fail(`Invalid PDF upload encoding: ${filename}. Choose the PDF again.`)
  return validatePdfBytes(filename, bytes)
}

export function pdfDisposition(filename) {
  const name = path.posix.basename(filename)
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `inline; filename="document.pdf"; filename*=UTF-8''${encoded}`
}
