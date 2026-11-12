import {
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_SVG_PREVIEW_BYTES,
  imageMimeType,
} from '../shared/file-previews.mjs'
import { parseFragment } from 'parse5'

const fail = (message, status = 415) => {
  throw Object.assign(new Error(message), { status })
}
const invalid = () =>
  fail(
    'This image is incomplete or does not match its file extension. Export it again before previewing.',
  )
function dimensions(width, height, frames = 1) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  )
    invalid()
  if (
    width > 16384 ||
    height > 16384 ||
    frames > 200 ||
    width * height * frames > MAX_IMAGE_PIXELS
  )
    fail(
      'This image has too many pixels or animation frames to preview. Resize it or export a still image.',
      413,
    )
}

function png(bytes) {
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    !bytes
      .subarray(-12)
      .equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
  )
    invalid()
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20)
  let offset = 8,
    frames = 1,
    headers = 0
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (offset + length + 12 > bytes.length) invalid()
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IHDR' && (length !== 13 || ++headers !== 1)) invalid()
    if (type === 'fcTL') {
      if (length !== 26) invalid()
      dimensions(
        bytes.readUInt32BE(offset + 12),
        bytes.readUInt32BE(offset + 16),
      )
    }
    if (type === 'acTL') {
      if (length !== 8) invalid()
      frames = bytes.readUInt32BE(offset + 8)
      if (!frames) invalid()
    }
    offset += length + 12
  }
  if (offset !== bytes.length) invalid()
  dimensions(width, height, frames)
}

function jpeg(bytes) {
  if (
    bytes.length < 4 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    invalid()
  let offset = 2,
    found = false
  const starts = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ])
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) invalid()
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) invalid()
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) invalid()
    if (starts.has(marker)) {
      if (length < 8) invalid()
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
      found = true
    }
    offset += length
  }
  if (!found) invalid()
}

function gif(bytes) {
  if (
    bytes.length < 14 ||
    !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ||
    bytes.at(-1) !== 0x3b
  )
    invalid()
  const width = bytes.readUInt16LE(6),
    height = bytes.readUInt16LE(8)
  dimensions(width, height)
  let offset = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0),
    frames = 0
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++]
      if (!length) return
      offset += length
      if (offset > bytes.length) invalid()
    }
    invalid()
  }
  while (offset < bytes.length) {
    const marker = bytes[offset++]
    if (marker === 0x3b) break
    if (marker === 0x21) {
      offset++
      skipBlocks()
      continue
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) invalid()
    dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6))
    const flags = bytes[offset + 8]
    offset += 9 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0)
    offset++ // LZW minimum code size.
    skipBlocks()
    dimensions(width, height, ++frames)
  }
  if (!frames || offset !== bytes.length) invalid()
}

function webp(bytes) {
  if (
    bytes.length < 20 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    invalid()
  let width,
    height,
    frames = 0,
    offset = 12
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4),
      length = bytes.readUInt32LE(offset + 4),
      start = offset + 8
    if (start + length > bytes.length) invalid()
    if (type === 'VP8X') {
      if (length < 10) invalid()
      width = bytes.readUIntLE(start + 4, 3) + 1
      height = bytes.readUIntLE(start + 7, 3) + 1
      dimensions(width, height)
    } else if (type === 'VP8 ') {
      if (
        length < 10 ||
        !bytes
          .subarray(start + 3, start + 6)
          .equals(Buffer.from([0x9d, 0x01, 0x2a]))
      )
        invalid()
      const frameWidth = bytes.readUInt16LE(start + 6) & 0x3fff,
        frameHeight = bytes.readUInt16LE(start + 8) & 0x3fff
      dimensions(frameWidth, frameHeight)
      width ??= frameWidth
      height ??= frameHeight
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) invalid()
      const size = bytes.readUInt32LE(start + 1)
      const frameWidth = (size & 0x3fff) + 1,
        frameHeight = ((size >>> 14) & 0x3fff) + 1
      dimensions(frameWidth, frameHeight)
      width ??= frameWidth
      height ??= frameHeight
    }
    if (type === 'ANMF') {
      if (length < 16) invalid()
      dimensions(
        bytes.readUIntLE(start + 6, 3) + 1,
        bytes.readUIntLE(start + 9, 3) + 1,
      )
      frames++
    }
    offset = start + length + (length & 1)
  }
  if (offset !== bytes.length) invalid()
  dimensions(width, height, frames || 1)
}

function bmp(bytes) {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 2) !== 'BM') invalid()
  const header = bytes.readUInt32LE(14)
  if (header === 12) dimensions(bytes.readUInt16LE(18), bytes.readUInt16LE(20))
  else if (header >= 40 && bytes.length >= 54)
    dimensions(bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22)))
  else invalid()
}

function ico(bytes) {
  if (
    bytes.length < 22 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))
  )
    invalid()
  const count = bytes.readUInt16LE(4)
  if (!count || count > 200 || bytes.length < 6 + count * 16) invalid()
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16,
      length = bytes.readUInt32LE(entry + 8),
      start = bytes.readUInt32LE(entry + 12)
    if (start < 6 + count * 16 || !length || start + length > bytes.length)
      invalid()
    const content = bytes.subarray(start, start + length)
    if (
      content
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      png(content)
    else {
      if (length < 40 || content.readUInt32LE(0) < 40) invalid()
      dimensions(content.readInt32LE(4), Math.abs(content.readInt32LE(8)))
    }
    dimensions(bytes[entry] || 256, bytes[entry + 1] || 256, count)
  }
}

function avif(bytes) {
  let branded = false,
    found = false,
    boxes = 0
  const walk = (start, end, depth = 0) => {
    if (depth > 16) invalid()
    let offset = start
    while (offset + 8 <= end) {
      if (++boxes > 4096) invalid()
      let length = bytes.readUInt32BE(offset),
        header = 8
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (length === 1) {
        if (offset + 16 > end) invalid()
        const big = bytes.readBigUInt64BE(offset + 8)
        if (big > BigInt(bytes.length)) invalid()
        length = Number(big)
        header = 16
      } else if (length === 0) length = end - offset
      if (length < header || offset + length > end) invalid()
      const payload = offset + header,
        limit = offset + length
      if (type === 'ftyp') {
        if (limit - payload < 8) invalid()
        const brands = [bytes.toString('ascii', payload, payload + 4)]
        for (let i = payload + 8; i + 4 <= limit; i += 4)
          brands.push(bytes.toString('ascii', i, i + 4))
        if (brands.includes('avis'))
          fail(
            'Animated AVIF is not supported in the preview. Export a still image.',
          )
        branded ||= brands.includes('avif')
      } else if (type === 'ispe') {
        if (limit - payload < 12) invalid()
        dimensions(
          bytes.readUInt32BE(payload + 4),
          bytes.readUInt32BE(payload + 8),
        )
        found = true
      } else if (['meta', 'iprp', 'ipco'].includes(type))
        walk(payload + (type === 'meta' ? 4 : 0), limit, depth + 1)
      offset = limit
    }
    if (offset !== end) invalid()
  }
  walk(0, bytes.length)
  if (!branded || !found) invalid()
}

function svg(bytes) {
  if (bytes.length > MAX_SVG_PREVIEW_BYTES)
    fail(
      'SVG previews must be at most 2 MiB. Simplify the drawing before previewing.',
      413,
    )
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    invalid()
  }
  const original = source
  const visible = source.replace(/<!--[\s\S]*?-->/g, '')
  if (source.includes('\0') || /<!\s*ENTITY\b/i.test(visible)) invalid()
  // Common SVG exporters include an external SVG DTD. Remove the declaration
  // from the preview rather than fetching it or refusing a normal figure.
  source = source
    .replace(/<!DOCTYPE\s+svg(?:\s+[^<>[\]]*)?>/gi, '')
    .replace(/<\?(?!xml(?:\s|\?>))[\s\S]*?\?>/gi, '')
  if (/<!\s*DOCTYPE\b/i.test(source.replace(/<!--[\s\S]*?-->/g, ''))) invalid()
  const inspected = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, '')
  const opening = /^\s*<svg\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>/i.exec(inspected)
  if (
    !opening ||
    (!/<\/svg\s*>\s*$/i.test(inspected) &&
      !(
        opening[1].trim().endsWith('/') &&
        opening[0].length === inspected.trimEnd().length
      ))
  )
    invalid()
  if ((inspected.match(/</g)?.length || 0) > 20000)
    fail(
      'This SVG has too many drawing elements to preview. Simplify it or download the original.',
      413,
    )
  const roots = parseFragment(inspected).childNodes.filter(
    (node) =>
      node.nodeName !== '#comment' &&
      (node.nodeName !== '#text' || node.value.trim()),
  )
  if (roots.length !== 1 || roots[0].tagName !== 'svg') invalid()
  for (const name of ['width', 'height']) {
    const value = roots[0].attrs.find(
      (attribute) => attribute.name === name,
    )?.value
    const size = /^\s*([\d.eE+-]+)\s*(px|in|cm|mm|pt|pc|q)?\s*$/i.exec(
      value || '',
    )
    if (size) {
      const multiplier = {
        px: 1,
        in: 96,
        cm: 96 / 2.54,
        mm: 96 / 25.4,
        pt: 96 / 72,
        pc: 16,
        q: 96 / 101.6,
      }[size[2]?.toLowerCase() || 'px']
      const value = Number(size[1]) * multiplier
      if (!Number.isFinite(value) || value > 16384)
        fail(
          'This SVG is too large to preview. Reduce its width and height.',
          413,
        )
    }
  }
  return source === original ? bytes : Buffer.from(source)
}

export function validateImageBytes(filename, bytes) {
  const type = imageMimeType(filename)
  if (!type)
    fail('Choose a PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or SVG image.')
  if (bytes.length > MAX_IMAGE_FILE_BYTES)
    fail('Images must be at most 16 MiB. Reduce the image and try again.', 413)
  const validators = {
    'image/png': png,
    'image/jpeg': jpeg,
    'image/gif': gif,
    'image/webp': webp,
    'image/avif': avif,
    'image/bmp': bmp,
    'image/x-icon': ico,
    'image/svg+xml': svg,
  }
  const normalized = validators[type](bytes)
  return normalized || bytes
}
