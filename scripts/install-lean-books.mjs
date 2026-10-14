#!/usr/bin/env node
// Explicit installation only: no downloads during server startup or browsing.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LEAN_BOOKS } from '../shared/lean-books.mjs'
import { bookDocument } from '../server/lean-book-html.mjs'
import {
  bookPath,
  containedBookFile,
  defaultBooksDir,
} from '../server/lean-books.mjs'

const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Supply a value for ${name}.`)
  return args[index + 1]
}
if (args.includes('--help')) {
  console.log(
    'node scripts/install-lean-books.mjs [--dir DIRECTORY] [--source DIRECTORY]\nUse --source to import existing HTML copies with the three book-id subdirectories.\nExisting installations are preserved; use a new --dir for a refreshed snapshot.',
  )
  process.exit(0)
}
for (let index = 0; index < args.length; index += 2)
  if (!['--dir', '--source'].includes(args[index]))
    throw new Error(`Unknown option: ${args[index]}`)
const root = path.resolve(option('--dir') || defaultBooksDir)
const source = option('--source') ? path.resolve(option('--source')) : null
await fs.mkdir(root, { recursive: true })
const allowedAssets = /\.(css|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf)$/i

for (const book of LEAN_BOOKS) {
  const destination = path.join(root, book.id)
  try {
    await fs.access(destination)
    console.log(`${book.title}: already installed; preserved.`)
    continue
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const staging = path.join(root, `install-${book.id}-${randomUUID()}`)
  await fs.mkdir(staging)
  const unavailableUrls = []
  try {
    if (source) {
      const input = await containedBookFile(source, book.id)
      await fs.cp(input, staging, { recursive: true, dereference: false })
    } else {
      const pending = [book.url],
        seen = new Set()
      const enqueue = (value, base, assetOnly = false) => {
        let url
        try {
          url = new URL(value, base)
          url.pathname = url.pathname.replace(/\/{2,}/g, '/')
        } catch {
          return
        }
        url.hash = ''
        url.search = ''
        if (!url.href.startsWith(book.url)) return
        const relative = decodeURIComponent(
          url.pathname.slice(new URL(book.url).pathname.length),
        )
        if (
          relative &&
          !relative.endsWith('/') &&
          !relative.endsWith('.html') &&
          !allowedAssets.test(relative)
        )
          return
        if (assetOnly && !allowedAssets.test(relative)) return
        if (!seen.has(url.href) && !pending.includes(url.href))
          pending.push(url.href)
      }
      while (pending.length) {
        const batch = pending.splice(0, 4)
        const outcomes = await Promise.allSettled(
          batch.map(async (url) => {
            if (seen.has(url)) return
            seen.add(url)
            if (seen.size > 10000)
              throw new Error(
                'Book exceeded the 10,000-file installation limit.',
              )
            let response
            for (let attempt = 0; attempt < 3; attempt++) {
              response = await fetch(url, {
                signal: AbortSignal.timeout(60000),
                redirect: 'error',
              })
              if (response.ok) break
              if (response.status !== 429 && response.status < 500) break
            }
            if (response.status === 404 && url !== book.url) {
              unavailableUrls.push(url)
              console.log(`${book.title}: upstream link unavailable: ${url}`)
              return
            }
            if (!response.ok)
              throw new Error(`Cannot download ${url}: HTTP ${response.status}`)
            let relative = decodeURIComponent(
              new URL(url).pathname.slice(new URL(book.url).pathname.length),
            )
            if (!relative || relative.endsWith('/')) relative += 'index.html'
            try {
              bookPath(relative)
            } catch (error) {
              throw new Error(
                `Invalid download path for ${url}: ${error.message}`,
                { cause: error },
              )
            }
            const bytes = Buffer.from(await response.arrayBuffer())
            if (bytes.length > 32 * 1024 * 1024)
              throw new Error(`Book file is too large: ${url}`)
            let content = bytes
            if (relative.endsWith('.html')) {
              const { elements } = bookDocument(bytes.toString('utf8'))
              const baseValue = elements
                .find((node) => node.tagName === 'base')
                ?.attrs.find((attr) => attr.name === 'href')?.value
              const base = new URL(baseValue || './', url).href
              for (const node of elements) {
                if (node.tagName === 'script') continue
                for (const attr of node.attrs)
                  if (['href', 'src', 'poster'].includes(attr.name))
                    enqueue(attr.value, base, node.tagName !== 'a')
              }
            } else if (relative.endsWith('.css')) {
              content = bytes
                .toString('utf8')
                .replace(
                  /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,
                  (match, _quote, value) => {
                    enqueue(value, url, true)
                    const target = new URL(value, url)
                    if (target.href.startsWith(book.url)) {
                      const relativeTarget = path.posix.relative(
                        path.posix.dirname(relative),
                        decodeURIComponent(
                          target.pathname.slice(
                            new URL(book.url).pathname.length,
                          ),
                        ),
                      )
                      return `url("${relativeTarget}${target.hash}")`
                    }
                    return match
                  },
                )
              for (const match of content.matchAll(
                /@import\s+['"]([^'"]+)['"]/g,
              ))
                enqueue(match[1], url, true)
            }
            const filename = path.join(staging, relative)
            await fs.mkdir(path.dirname(filename), { recursive: true })
            await fs.writeFile(filename, content)
          }),
        )
        for (const outcome of outcomes)
          if (outcome.status === 'rejected') throw outcome.reason
        if (seen.size % 40 < 4)
          console.log(`${book.title}: ${seen.size} files downloaded…`)
      }
    }
    const pages = []
    const scan = async (directory, prefix = '') => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const relative = prefix + entry.name
        bookPath(relative)
        if (entry.isSymbolicLink())
          throw new Error(`Books must not contain symlinks: ${relative}`)
        if (entry.isDirectory()) {
          if (entry.name !== 'leanflow-text')
            await scan(path.join(directory, entry.name), relative + '/')
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
          const { title, text } = bookDocument(
            await fs.readFile(path.join(directory, entry.name), 'utf8'),
          )
          const textPath = `leanflow-text/${pages.length}.txt`
          await fs.mkdir(path.join(staging, 'leanflow-text'), {
            recursive: true,
          })
          await fs.writeFile(
            path.join(staging, textPath),
            `${title}\nSource: ${new URL(relative.replace(/index\.html$/, ''), book.url).href}\n\n${text}\n`,
          )
          pages.push({
            path: relative.replace(/index\.html$/, ''),
            title,
            textPath,
          })
        }
      }
    }
    await scan(staging)
    if (!pages.some((page) => page.path === ''))
      throw new Error(`${book.title} needs an index.html at its root.`)
    const home = bookDocument(
      await fs.readFile(path.join(staging, 'index.html'), 'utf8'),
    ).text
    const leanVersion =
      /(?:version|release|specifically)\s*[`(\s]*(4\.\d+\.\d+)/i.exec(
        home,
      )?.[1] || null
    await fs.writeFile(
      path.join(staging, 'manifest.json'),
      JSON.stringify(
        {
          downloadedAt: new Date().toISOString(),
          leanVersion,
          pages,
          unavailableUrls,
        },
        null,
        2,
      ),
    )
    await fs.rename(staging, destination)
    console.log(
      `${book.title}: installed ${pages.length} chapters${leanVersion ? ` (Lean ${leanVersion})` : ''}.`,
    )
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
}
