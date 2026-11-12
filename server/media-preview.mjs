import path from 'node:path'
import { parse, serialize } from 'parse5'
import {
  MAX_IMAGE_FILE_BYTES,
  MAX_HTML_PREVIEW_BYTES,
  MAX_SVG_PREVIEW_BYTES,
  imageMimeType,
  isHtmlFile,
  isSvgFile,
} from '../shared/file-previews.mjs'
import { validateImageBytes } from './image-preview.mjs'
import { downloadDisposition } from './project-downloads.mjs'
import { validateWorkspaceFilePath } from './workspaces.mjs'

export const HTML_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox"
const IMAGE_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox"
const MAX_ASSET_BYTES = 16 * 1024 * 1024
const MAX_ASSETS = 32
const allowedTags = new Set(
  `html head body title style p div span article section main aside header footer nav h1 h2 h3 h4 h5 h6 br hr a img picture figure figcaption ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col pre code blockquote b strong i em u s del ins small sub sup mark q abbr time address details summary math mrow mi mn mo msup msub msubsup mfrac msqrt mroot mtable mtr mtd mtext munderover mover munder semantics annotation svg g path circle ellipse rect line polygon polyline text tspan defs marker linearGradient radialGradient stop clipPath mask pattern use desc`.split(
    ' ',
  ),
)
const allowedAttributes = new Set(
  `id class style title lang dir width height alt loading colspan rowspan scope start reversed value type open datetime role aria-label aria-hidden viewBox preserveAspectRatio d x y x1 y1 x2 y2 cx cy r rx ry points fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity transform font-size font-family font-weight text-anchor dominant-baseline dx dy offset stop-color stop-opacity gradientUnits gradientTransform markerWidth markerHeight refX refY orient marker-start marker-mid marker-end clip-path clipPathUnits maskUnits patternUnits patternContentUnits patternTransform xmlns display mathvariant encoding`.split(
    ' ',
  ),
)
const fail = (message, status = 415) => {
  throw Object.assign(new Error(message), { status })
}

function text(bytes) {
  if (bytes.includes(0)) fail('This preview requires a UTF-8 text document.')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('This preview requires a UTF-8 text document.')
  }
}

function localAsset(base, value) {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null
  let decoded
  try {
    decoded = decodeURIComponent(value.split(/[?#]/)[0])
  } catch {
    return null
  }
  if (
    !decoded ||
    decoded.includes('\\') ||
    [...decoded].some((character) => character.charCodeAt(0) < 32)
  )
    return null
  const joined = path.posix.normalize(
    decoded.startsWith('/')
      ? decoded.slice(1)
      : path.posix.join(path.posix.dirname(base), decoded),
  )
  if (joined === '..' || joined.startsWith('../')) return null
  return joined
}

function dataImage(value) {
  const match =
    /^data:(image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
      value,
    )
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_FILE_BYTES / 3) * 4)
    return null
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.toString('base64') !== match[2]) return null
  const extension = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/svg+xml': 'svg',
  }[match[1].toLowerCase()]
  let normalized
  try {
    normalized = validateImageBytes(`inline.${extension}`, bytes)
  } catch {
    return null
  }
  return {
    bytes: normalized,
    uri: `data:${match[1].toLowerCase()};base64,${normalized.toString('base64')}`,
  }
}

// Render static project documents without granting their contents an origin or
// network access. Local assets are embedded so sandboxed previews need no cookie.
export async function sanitizedHtmlPreview(source, filename, readAsset) {
  const document = parse(source)
  let nodes = 0,
    assets = 0,
    assetBytes = 0,
    attempts = 0
  const cache = new Map()
  const reserve = (bytes) => {
    if (++assets > MAX_ASSETS || assetBytes + bytes > MAX_ASSET_BYTES)
      return false
    assetBytes += bytes
    return true
  }
  const image = async (base, value) => {
    if (value.startsWith('data:')) {
      const embedded = dataImage(value)
      return embedded && reserve(embedded.bytes.length) ? embedded.uri : null
    }
    const name = localAsset(base, value)
    if (!name || !imageMimeType(name)) return null
    if (cache.has(name)) return cache.get(name)
    if (++attempts > MAX_ASSETS || assets >= MAX_ASSETS) return null
    let uri = null
    try {
      const file = await readAsset(
        name,
        isSvgFile(name) ? MAX_SVG_PREVIEW_BYTES : MAX_IMAGE_FILE_BYTES,
      )
      const normalized = validateImageBytes(name, file.content)
      if (reserve(normalized.length))
        uri = `data:${imageMimeType(name)};base64,${normalized.toString('base64')}`
    } catch (error) {
      // Permission changes abort the whole preview; a missing optional asset
      // simply keeps the document's alt text visible.
      if ([401, 403].includes(error.status)) throw error
    }
    cache.set(name, uri)
    return uri
  }
  const css = async (content, base) => {
    let result = '',
      offset = 0
    const expression = /url\(\s*(?:(["'])([\s\S]*?)\1|([^)]*))\s*\)/gi
    for (const match of content.matchAll(expression)) {
      result += content.slice(offset, match.index)
      const value = (match[2] ?? match[3]).trim()
      const uri =
        value.startsWith('#') && /^#[\w:.-]+$/.test(value)
          ? value
          : await image(base, value)
      result += uri ? `url("${uri}")` : 'none'
      offset = match.index + match[0].length
    }
    // Escaping '<' prevents a stylesheet file from closing its HTML style tag.
    return (result + content.slice(offset)).replace(/</g, '\\3c ')
  }
  const walk = async (node, depth = 0) => {
    if (++nodes > 20000 || depth > 128)
      fail(
        'This HTML document is too complex to preview. Simplify it or download it to view locally.',
        413,
      )
    if (!node.childNodes) return
    const children = []
    for (const child of node.childNodes) {
      if (child.nodeName === '#text') {
        children.push(child)
        continue
      }
      const tag = child.tagName
      if (tag === 'link') {
        const attrs = Object.fromEntries(
          child.attrs.map(({ name, value }) => [name, value]),
        )
        const name =
          attrs.rel?.toLowerCase() === 'stylesheet' &&
          localAsset(filename, attrs.href)
        if (
          name &&
          /\.css$/i.test(name) &&
          assets < MAX_ASSETS &&
          ++attempts <= MAX_ASSETS
        ) {
          try {
            const file = await readAsset(name, 1024 * 1024)
            if (reserve(file.content.length)) {
              child.tagName = 'style'
              child.nodeName = 'style'
              child.attrs = []
              child.childNodes = [
                {
                  nodeName: '#text',
                  value: await css(text(file.content), name),
                  parentNode: child,
                },
              ]
              children.push(child)
            }
          } catch (error) {
            if ([401, 403].includes(error.status)) throw error
          }
        }
        continue
      }
      if (!allowedTags.has(tag)) continue
      const attrs = []
      for (const attribute of child.attrs || []) {
        const { name, value } = attribute
        if (name === 'src' && tag === 'img') {
          const uri = await image(filename, value)
          if (uri) attrs.push({ ...attribute, value: uri })
        } else if (name === 'href' && ['a', 'use'].includes(tag)) {
          if (/^#[\w:.-]+$/.test(value)) attrs.push(attribute)
        } else if (allowedAttributes.has(name)) {
          if (name === 'style')
            attrs.push({ ...attribute, value: await css(value, filename) })
          else if (
            !/url\s*\(/i.test(value) ||
            /^url\(\s*["']?#[\w:.-]+["']?\s*\)$/i.test(value)
          )
            attrs.push(attribute)
        }
      }
      child.attrs = attrs
      if (tag === 'style') {
        child.childNodes = [
          {
            nodeName: '#text',
            value: await css(
              child.childNodes.map((part) => part.value || '').join(''),
              filename,
            ),
            parentNode: child,
          },
        ]
      } else await walk(child, depth + 1)
      children.push(child)
    }
    node.childNodes = children
  }
  await walk(document)
  return (
    '<!doctype html>' + serialize(document).replace(/^<!DOCTYPE html>/i, '')
  )
}

export async function readMediaPreview(workspaces, id, actor, filename) {
  workspaces.get(id, actor)
  validateWorkspaceFilePath(filename)
  const type = imageMimeType(filename)
  if (!type && !isHtmlFile(filename))
    fail('Choose an image, HTML, or PDF file to preview.')
  const limit = isHtmlFile(filename)
    ? MAX_HTML_PREVIEW_BYTES
    : isSvgFile(filename)
      ? MAX_SVG_PREVIEW_BYTES
      : MAX_IMAGE_FILE_BYTES
  let file
  try {
    file = await workspaces.readDownloadFile(id, actor, filename, {
      byteLimit: limit,
    })
  } catch (error) {
    if (error.status === 413)
      fail(
        `This ${isHtmlFile(filename) ? 'HTML document' : isSvgFile(filename) ? 'SVG' : 'image'} exceeds the ${limit / (1024 * 1024)} MiB preview limit. Reduce it or download the original file.`,
        413,
      )
    throw error
  }
  workspaces.get(id, actor)
  let content
  if (type) content = validateImageBytes(filename, file.content)
  else
    content = await sanitizedHtmlPreview(
      text(file.content),
      file.path,
      async (name, byteLimit) => {
        const asset = await workspaces.readDownloadFile(id, actor, name, {
          byteLimit,
        })
        workspaces.get(id, actor)
        return asset
      },
    )
  workspaces.get(id, actor)
  return { path: file.path, content, type: type || 'text/html; charset=utf-8' }
}

export function sendMediaPreview(res, preview) {
  res.setHeader('Content-Type', preview.type)
  res.setHeader(
    'Content-Disposition',
    downloadDisposition(preview.path).replace(/^attachment/, 'inline'),
  )
  res.setHeader(
    'Content-Security-Policy',
    preview.type.startsWith('text/html') ? HTML_PREVIEW_CSP : IMAGE_PREVIEW_CSP,
  )
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.send(preview.content)
}
