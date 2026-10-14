import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createStudio } from '../studio.mjs'
import { LeanBooks, bookPath } from '../lean-books.mjs'
import { LEAN_BOOKS } from '../../shared/lean-books.mjs'

const html = (title, body) =>
  `<!doctype html><html><head><title>${title}</title><base href="./"><link rel="stylesheet" href="book.css"><script>parent.document.body.innerHTML = 'unsafe'</script></head><body><nav>Navigation text</nav><main><h1>${title}</h1>${body}</main></body></html>`

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-books-'))
  const source = path.join(directory, 'source')
  const booksDir = path.join(directory, '.books')
  for (const book of LEAN_BOOKS) {
    const root = path.join(source, book.id)
    await fs.mkdir(path.join(root, 'Tactics'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'index.html'),
      html(
        book.title,
        '<p>This manual covers Lean version 4.34.1.</p><a href="Tactics/">Read tactics</a>',
      ),
    )
    await fs.writeFile(path.join(root, 'book.css'), 'body { color: #123456; }')
    await fs.writeFile(
      path.join(root, 'Tactics/index.html'),
      html(
        'Tactics',
        '<p id="induction">Induction proves recursive propositions &amp; lemmas.</p><pre>example : True := by trivial</pre><a href="../">Contents</a><a href="https://lean-lang.org/theorem_proving_in_lean4/">Other book</a><a href="https://example.com/">External</a><a href="javascript:alert(1)" onclick="alert(1)">Unsafe</a><meta http-equiv="refresh" content="0;url=/api/session"><iframe src="/api/session"></iframe>',
      ),
    )
  }
  await promisify(execFile)(process.execPath, [
    'scripts/install-lean-books.mjs',
    '--source',
    source,
    '--dir',
    booksDir,
  ])
  const books = new LeanBooks(booksDir)
  const studio = await createStudio({
    dataDir: path.join(directory, 'data'),
    books,
    runtime: {
      async init() {},
      info: () => ({ ready: true }),
      templates: () => [],
      templateRoot: () => null,
      async shutdown() {},
      spawn() {
        assert.fail('Documentation must not start a worker or call a provider')
      },
    },
    config: {
      defaultModel: 'fixture',
      models: [],
      provider: {},
      lemex: {},
      redact: String,
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const token = (
    await fs.readFile(path.join(directory, 'data/auth/owner.token'), 'utf8')
  ).trim()
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const request = (url, authenticated = true) =>
    fetch(base + url, {
      headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    })
  t.after(async () => {
    await studio.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { directory, booksDir, books, request }
}

test('installed books browse and search locally behind authentication, with safe embedded HTML', async (t) => {
  const { request } = await fixture(t)
  for (const url of [
    '/api/books',
    '/api/books/search?q=induction',
    '/api/books/reference/content/Tactics/',
    '/api/books/reference/content/book.css',
  ])
    assert.equal((await request(url, false)).status, 401)
  const catalog = await (await request('/api/books')).json()
  assert.equal(catalog.length, 3)
  assert(
    catalog.every(
      (book) =>
        book.available && book.pageCount === 2 && book.leanVersion === '4.34.1',
    ),
  )
  const page = await request('/api/books/reference/content/Tactics/')
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.match(
    page.headers.get('content-security-policy'),
    /sandbox allow-same-origin/,
  )
  assert.doesNotMatch(
    page.headers.get('content-security-policy'),
    /allow-scripts/,
  )
  const content = await page.text()
  assert.match(content, /href="\/api\/books\/reference\/content\/"/)
  assert.match(content, /href="\/api\/books\/theorem-proving\/content\/"/)
  assert.match(content, /target="_blank" rel="noopener noreferrer"/)
  assert.doesNotMatch(
    content,
    /<script|<iframe|<base|onclick|javascript:|http-equiv/,
  )
  assert.match(content, /Induction proves recursive propositions &amp; lemmas/)
  assert.equal(
    (await request('/api/books/reference/content/book.css')).status,
    200,
  )
  const search = await (
    await request('/api/books/search?q=induction&book=reference')
  ).json()
  assert.equal(search.length, 1)
  assert.equal(search[0].url, '/api/books/reference/content/Tactics/')
  assert.match(
    search[0].excerpt,
    /Induction proves recursive propositions & lemmas/,
  )
  assert.doesNotMatch(search[0].excerpt, /Navigation text|parent.document/)
  assert.equal((await request('/api/books/search?q=x')).status, 400)
  assert.equal(
    (await request('/api/books/search?q=induction&book=unknown')).status,
    400,
  )
})

test('book serving rejects symlinks, encoded traversal, secrets, scripts and unknown books', async (t) => {
  const { directory, booksDir, request } = await fixture(t)
  const secret = path.join(directory, 'private.txt')
  await fs.writeFile(secret, 'private fixture data')
  await fs.symlink(secret, path.join(booksDir, 'reference', 'secret.txt'))
  assert.equal(
    (await request('/api/books/reference/content/secret.txt')).status,
    403,
  )
  for (const url of [
    '/api/books/reference/content/%2e%2e%2fprivate.txt',
    '/api/books/reference/content/%252e%252e%252fprivate.txt',
    '/api/books/reference/content/.env',
    '/api/books/reference/content/evil.js',
    '/api/books/unknown/content/',
    '/api/books/reference/content/%5cprivate.txt',
  ]) {
    const response = await request(url)
    assert([400, 404].includes(response.status), `${url}: ${response.status}`)
    assert.doesNotMatch(await response.text(), /private fixture data/)
  }
  for (const value of [
    '../secret',
    'a/../secret',
    '/secret',
    'a\\secret',
    '.env',
    'x\0y',
  ])
    assert.throws(() => bookPath(value))
})

test('Lemex receives readable private copies and local chapter citations without changing shared originals', async (t) => {
  const { directory, books, booksDir, request } = await fixture(t)
  const home = path.join(directory, 'worker-home')
  await fs.mkdir(home)
  const instructions = await books.prepareAgent(home)
  assert.match(instructions, /\/home\/worker\/lean-books/)
  assert.match(instructions, /pinned Lean version/)
  for (const book of LEAN_BOOKS) assert(instructions.includes(book.title))
  const catalog = JSON.parse(
    await fs.readFile(path.join(home, 'lean-books/catalog.json'), 'utf8'),
  )
  assert.equal(catalog.length, 6)
  const chapter = catalog.find(
    (entry) =>
      entry.book === 'Lean Language Reference' && entry.title === 'Tactics',
  )
  assert.equal(chapter.url, '/api/books/reference/content/Tactics/')
  const copy = path.join(home, chapter.file.replace('/home/worker/', ''))
  const text = await fs.readFile(copy, 'utf8')
  assert.match(text, /example : True := by trivial/)
  const reference = /^Reference: \[([^\]]+)\]\(([^)]+)\)/.exec(text)
  assert(reference, 'A chapter can be cited directly from its readable text')
  assert.equal(reference[1], 'Lean Language Reference — Tactics')
  assert.equal(reference[2], chapter.url)
  const linkedPage = await request(reference[2])
  assert.equal(linkedPage.status, 200)
  assert.match(
    await linkedPage.text(),
    /Induction proves recursive propositions/,
  )
  await fs.writeFile(copy, 'Changed private worker copy')
  const original = (await books.catalog())
    .find((book) => book.id === 'reference')
    .pages.find((page) => page.title === 'Tactics')
  assert.match(
    await fs.readFile(
      path.join(booksDir, 'reference', original.textPath),
      'utf8',
    ),
    /Induction/,
  )
  assert.equal((await fs.stat(copy)).nlink, 1)
})

test('missing books remain an actionable catalog state and do not add agent instructions', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-missing-books-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const books = new LeanBooks(root)
  assert((await books.list()).every((book) => !book.available))
  assert.equal(await books.prepareAgent(path.join(root, 'home')), '')
  await assert.rejects(books.file('reference', ''), { status: 404 })
  await fs.mkdir(path.join(root, 'reference'))
  await fs.writeFile(
    path.join(root, 'reference/manifest.json'),
    JSON.stringify({ pages: [], leanVersion: '4.34.1' }),
  )
  assert.equal(
    (await books.list()).find((book) => book.id === 'reference').available,
    true,
  )
})

test('worker book preparation refuses symlinks and hardlinked targets without overwriting unrelated files', async (t) => {
  const { directory, books } = await fixture(t)
  for (const linkType of ['symlink', 'hardlink']) {
    const home = path.join(directory, linkType)
    const target = path.join(home, 'lean-books/functional-programming')
    await fs.mkdir(target, { recursive: true })
    const privateFile = path.join(directory, `private-${linkType}.txt`)
    await fs.writeFile(privateFile, 'preserved private fixture')
    if (linkType === 'symlink')
      await fs.symlink(privateFile, path.join(target, '0.txt'))
    else await fs.link(privateFile, path.join(target, '0.txt'))
    await assert.rejects(books.prepareAgent(home), /Invalid worker book file/)
    assert.equal(
      await fs.readFile(privateFile, 'utf8'),
      'preserved private fixture',
    )
  }
})
