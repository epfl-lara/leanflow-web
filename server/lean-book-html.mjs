import { parse, serialize } from 'parse5'
import { bookPageUrl, localBookLink } from '../shared/lean-books.mjs'

const ignoredText = new Set([
  'script',
  'style',
  'nav',
  'header',
  'footer',
  'form',
])
const blocks = new Set([
  'p',
  'div',
  'section',
  'pre',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'br',
  'tr',
])

export function bookDocument(html) {
  const document = parse(html)
  const elements = []
  const walk = (node) => {
    if (node.tagName) elements.push(node)
    for (const child of node.childNodes || []) walk(child)
  }
  walk(document)
  const text = (node) => {
    if (ignoredText.has(node.tagName)) return ''
    if (node.nodeName === '#text') return node.value
    return (
      (node.childNodes || []).map(text).join('') +
      (blocks.has(node.tagName) ? '\n' : '')
    )
  }
  const title = elements.find((node) => node.tagName === 'title')
  const main =
    elements.find((node) => node.tagName === 'main') ||
    elements.find((node) => node.tagName === 'body')
  return {
    document,
    elements,
    title: title ? text(title).trim() : 'Untitled chapter',
    text: text(main || document)
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  }
}

export function readableBookHtml(html, sourceUrl) {
  const { document, elements } = bookDocument(html)
  const baseElement = elements.find((node) => node.tagName === 'base')
  let base = sourceUrl
  try {
    base = new URL(
      baseElement?.attrs.find((attr) => attr.name === 'href')?.value || './',
      sourceUrl,
    ).href
  } catch {}
  for (const node of elements) {
    if (
      ['script', 'base', 'form', 'iframe', 'object', 'embed'].includes(
        node.tagName,
      ) ||
      (node.tagName === 'meta' &&
        node.attrs.some((attr) => attr.name === 'http-equiv'))
    ) {
      node.parentNode.childNodes = node.parentNode.childNodes.filter(
        (child) => child !== node,
      )
      continue
    }
    node.attrs = node.attrs.filter(
      (attr) =>
        !attr.name.startsWith('on') &&
        !['srcdoc', 'action', 'formaction'].includes(attr.name) &&
        !(node.tagName === 'a' && ['target', 'rel'].includes(attr.name)),
    )
    for (const attr of node.attrs) {
      if (
        !['href', 'src', 'poster'].includes(attr.name) ||
        attr.value.startsWith('#')
      )
        continue
      const local = localBookLink(attr.value, base)
      if (local) attr.value = bookPageUrl(local.id, local.page) + local.hash
      else {
        let remote
        try {
          remote = new URL(attr.value, base)
        } catch {}
        if (
          node.tagName === 'a' &&
          remote &&
          ['http:', 'https:'].includes(remote.protocol)
        ) {
          attr.value = remote.href
          node.attrs.push(
            { name: 'target', value: '_blank' },
            { name: 'rel', value: 'noopener noreferrer' },
          )
        } else attr.value = ''
      }
    }
  }
  // The upstream books have white reading surfaces. Give them a complete
  // light canvas so a dark application does not supply white default text.
  const root = elements.find((node) => node.tagName === 'html')
  const style = root.attrs.find((attr) => attr.name === 'style')
  const readingStyle =
    'color-scheme: light; color: var(--verso-text-color, #111); background: white;'
  if (style) style.value += ';' + readingStyle
  else root.attrs.push({ name: 'style', value: readingStyle })
  return serialize(document)
}
