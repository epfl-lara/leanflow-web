import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createStudio } from '../studio.mjs'
import { validateImageBytes } from '../image-preview.mjs'
import { sanitizedHtmlPreview } from '../media-preview.mjs'
import {
  imageMimeType,
  isBinaryAssetFile,
  isImageFile,
  MAX_IMAGE_FILE_BYTES,
} from '../../shared/file-previews.mjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64',
)
const gif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
)
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>',
)
const jpeg = Buffer.from([
  255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0,
  255, 217,
])
const webp = Buffer.alloc(26)
webp.write('RIFF')
webp.writeUInt32LE(18, 4)
webp.write('WEBPVP8L', 8)
webp.writeUInt32LE(5, 16)
webp[20] = 0x2f
const bmp = Buffer.alloc(58)
bmp.write('BM')
bmp.writeUInt32LE(58, 2)
bmp.writeUInt32LE(54, 10)
bmp.writeUInt32LE(40, 14)
bmp.writeInt32LE(1, 18)
bmp.writeInt32LE(1, 22)
bmp.writeUInt16LE(1, 26)
bmp.writeUInt16LE(24, 28)
const ico = Buffer.alloc(22 + png.length)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico[6] = 1
ico[7] = 1
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(22, 18)
png.copy(ico, 22)
function box(type, content) {
  const bytes = Buffer.alloc(8 + content.length)
  bytes.writeUInt32BE(bytes.length)
  bytes.write(type, 4)
  content.copy(bytes, 8)
  return bytes
}
const ispe = Buffer.alloc(12)
ispe.writeUInt32BE(1, 4)
ispe.writeUInt32BE(1, 8)
const avif = Buffer.concat([
  box('ftyp', Buffer.from('avif\0\0\0\0avif')),
  box(
    'meta',
    Buffer.concat([
      Buffer.alloc(4),
      box('iprp', box('ipco', box('ispe', ispe))),
    ]),
  ),
])
const formats = { png, gif, svg, jpeg, webp, bmp, ico, avif }

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-media-preview-'),
  )
  const toolchain = 'leanprover/lean4:v4.34.1'
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain }],
    templateRoot: () => null,
    async prepareToolchain() {},
    spawn() {
      assert.fail('Media previews must not start a worker or provider')
    },
    async run(root, args) {
      if (args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'lake' && args[1] === 'update')
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      return {
        code: 0,
        stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '',
        stderr: '',
      }
    },
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    config: {
      defaultModel: 'fixture',
      models: [{ id: 'fixture' }],
      provider: {},
      lemex: {},
      redact: String,
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const owner = {
    id: 'owner',
    token: (
      await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
    ).trim(),
  }
  const accounts = { owner }
  for (const name of ['Viewer', 'Outsider']) {
    const account = await studio.auth.createUser(owner, { name })
    accounts[name.toLowerCase()] = { id: account.user.id, token: account.token }
  }
  const project = await studio.workspaces.create(owner.id, {
    name: 'Media fixture',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  await studio.workspaces.setMember(
    project.id,
    owner.id,
    accounts.viewer.id,
    'viewer',
  )
  runtime.run = () => assert.fail('Media reads must not run commands')
  const base = `http://127.0.0.1:${studio.server.address().port}/api/projects/${project.id}`
  const preview = (name, actor = owner) =>
    fetch(`${base}/file-preview?path=${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(5000),
      headers: actor ? { Authorization: `Bearer ${actor.token}` } : {},
    })
  return { ...studio, ...accounts, project, dataDir, preview, base }
}

test('image previews retain supported bytes and MIME only for project members, including viewers', async (t) => {
  const f = await fixture(t)
  for (const [extension, bytes] of Object.entries(formats)) {
    await fs.writeFile(path.join(f.project.root, `figure.${extension}`), bytes)
    const response = await f.preview(`figure.${extension}`, f.viewer)
    assert.equal(response.status, 200, extension)
    assert.equal(
      response.headers.get('content-type'),
      imageMimeType(`figure.${extension}`),
    )
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(
      response.headers.get('content-security-policy'),
      /default-src 'none'.*sandbox/,
    )
    assert.equal(
      response.headers.get('cross-origin-resource-policy'),
      'same-origin',
    )
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  }
  assert.equal((await f.preview('figure.png', null)).status, 401)
  assert.equal((await f.preview('figure.png', f.outsider)).status, 404)
  await f.workspaces.removeMember(f.project.id, f.owner.id, f.viewer.id)
  assert.equal((await f.preview('figure.png', f.viewer)).status, 404)
})

test('media previews reject traversal, hidden files, symlinks, bad content, dimensions, and oversized images', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.dataDir, 'outside.png'), png)
  await fs.symlink(
    path.join(f.dataDir, 'outside.png'),
    path.join(f.project.root, 'link.png'),
  )
  await fs.symlink(f.dataDir, path.join(f.project.root, 'escape'))
  await fs.writeFile(
    path.join(f.project.root, 'wrong.png'),
    '<html>not an image</html>',
  )
  await fs.writeFile(
    path.join(f.project.root, 'entity.svg'),
    '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg>&secret;</svg>',
  )
  await fs.writeFile(path.join(f.project.root, 'large.png'), png)
  await fs.truncate(
    path.join(f.project.root, 'large.png'),
    MAX_IMAGE_FILE_BYTES + 1,
  )
  const huge = Buffer.from(png)
  huge.writeUInt32BE(20000, 16)
  await fs.writeFile(path.join(f.project.root, 'huge.png'), huge)
  for (const [filename, status] of [
    ['../outside.png', 400],
    ['/outside.png', 400],
    ['.env/private.svg', 400],
    ['.git/private.svg', 400],
    ['link.png', 403],
    ['escape/outside.png', 403],
    ['wrong.png', 415],
    ['entity.svg', 415],
    ['large.png', 413],
    ['huge.png', 413],
    ['missing.gif', 404],
    ['Main.lean', 415],
  ]) {
    const response = await f.preview(filename)
    assert.equal(response.status, status, filename)
    assert.equal(typeof (await response.json()).error, 'string')
  }
})

test('SVG remains editable text and HTML previews embed only bounded project-local assets', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.project.root, 'docs'))
  await fs.mkdir(path.join(f.project.root, 'assets'))
  await fs.writeFile(path.join(f.project.root, 'assets/plot.png'), png)
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text y="20">Editable figure</text></svg>'
  await f.workspaces.writeFile(
    f.project.id,
    f.owner.id,
    'assets/plot.svg',
    source,
    null,
  )
  assert.equal(isBinaryAssetFile('assets/plot.svg'), false)
  const original = await f.workspaces.readFile(
    f.project.id,
    f.owner.id,
    'assets/plot.svg',
  )
  await f.workspaces.applyChanges(f.project.id, f.owner.id, [
    {
      path: 'assets/plot.svg',
      beforeHash: original.hash,
      after: source.replace('Editable', 'Edited'),
    },
  ])
  assert.match(
    (await f.workspaces.readFile(f.project.id, f.owner.id, 'assets/plot.svg'))
      .content,
    /Edited figure/,
  )
  await fs.writeFile(
    path.join(f.project.root, 'docs/theme.css'),
    'body{color:navy;background-image:url("../assets/plot.png")} /* </style><script>parent.pwned=true</script> */',
  )
  const html = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://external.invalid"><base href="https://external.invalid/"><link rel="stylesheet" href="theme.css"><script>parent.pwned=true;fetch('/api/session')</script></head><body onload="alert(1)"><h1>Local report</h1><img alt="Local plot" src="../assets/plot.png"><img src="https://external.invalid/track.png"><iframe src="/api/session"></iframe><object data="/api/session"></object><form action="/api/projects"><input name="delete"><button>Submit</button></form><a href="javascript:alert(1)">External action</a><svg><script>alert(1)</script><circle r="5"/></svg></body></html>`
  await fs.writeFile(path.join(f.project.root, 'docs/report.html'), html)
  const response = await f.preview('docs/report.html', f.viewer)
  assert.equal(response.status, 200)
  assert.match(
    response.headers.get('content-type'),
    /^text\/html; charset=utf-8$/,
  )
  assert.match(response.headers.get('content-security-policy'), /img-src data:/)
  const rendered = await response.text()
  assert.match(rendered, /Local report/)
  assert.match(rendered, /data:image\/png;base64,/)
  assert.match(rendered, /body\{color:navy/)
  assert.match(rendered, /Edited|circle/)
  assert.doesNotMatch(
    rendered,
    /<(?:script|iframe|object|form|input|button|base|meta)\b|\bonload=|href="javascript:|https:\/\/external\.invalid/i,
  )
  assert.match(rendered, /\\3c \/style>/)
  assert.equal(
    createHash('sha256')
      .update(await fs.readFile(path.join(f.project.root, 'docs/report.html')))
      .digest('hex'),
    createHash('sha256').update(html).digest('hex'),
    'Preview never rewrites project files',
  )
})

test('media MIME mapping rejects inherited names and image headers with excessive dimensions', () => {
  for (const filename of [
    'image.constructor',
    'image.__proto__',
    'image.toString',
    'figure.tiff',
    'noextension',
    null,
  ]) {
    assert.equal(imageMimeType(filename), null)
    assert.equal(isImageFile(filename), false)
  }
  for (const [extension, bytes] of Object.entries(formats))
    assert.equal(validateImageBytes(`figure.${extension}`, bytes), bytes)
  const variants = []
  const largeGif = Buffer.from(gif)
  largeGif.writeUInt16LE(20000, 6)
  variants.push(['gif', largeGif])
  const largeJpeg = Buffer.from(jpeg)
  largeJpeg.writeUInt16BE(20000, 7)
  variants.push(['jpeg', largeJpeg])
  const largeBmp = Buffer.from(bmp)
  largeBmp.writeInt32LE(20000, 18)
  variants.push(['bmp', largeBmp])
  const largeAvif = Buffer.from(avif)
  largeAvif.writeUInt32BE(20000, largeAvif.indexOf('ispe') + 8)
  variants.push(['avif', largeAvif])
  variants.push(['svg', Buffer.from('<svg width="1e9" height="10"/>')])
  for (const [extension, bytes] of variants)
    assert.throws(
      () => validateImageBytes(`figure.${extension}`, bytes),
      { status: 413 },
      extension,
    )
  for (const extension of Object.keys(formats))
    assert.throws(
      () =>
        validateImageBytes(`figure.${extension}`, Buffer.from('not an image')),
      { status: 415 },
      extension,
    )
})

test('HTML sanitization limits asset work and rejects path escape without reading outside the project', async () => {
  const reads = []
  const html =
    '<h1>Report</h1>' +
    Array.from(
      { length: 100 },
      (_, index) => `<img src="missing-${index}.png">`,
    ).join('') +
    '<img src="../../outside.png">'
  const result = await sanitizedHtmlPreview(
    html,
    'docs/index.html',
    async (name) => {
      reads.push(name)
      throw Object.assign(new Error('Missing'), { status: 404 })
    },
  )
  assert.equal(reads.length, 32)
  assert(!reads.some((name) => name.startsWith('../')))
  assert.doesNotMatch(result, /src=/)
  await assert.rejects(
    sanitizedHtmlPreview(
      '<div>'.repeat(160) + 'x' + '</div>'.repeat(160),
      'index.html',
      async () => assert.fail('No assets expected'),
    ),
    { status: 413 },
  )
})

test('expanded image uploads preserve binary data while SVG uploads remain editable source', async (t) => {
  const f = await fixture(t)
  const uploaded = Object.entries(formats).map(([extension, bytes]) => ({
    path: `uploads/figure.${extension}`,
    content:
      extension === 'svg' ? bytes.toString('utf8') : bytes.toString('base64'),
    ...(extension === 'svg' ? {} : { encoding: 'base64' }),
  }))
  const response = await fetch(`${f.base}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${f.owner.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: uploaded }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  for (const [extension, bytes] of Object.entries(formats)) {
    assert.deepEqual(
      await fs.readFile(
        path.join(f.project.root, `uploads/figure.${extension}`),
      ),
      bytes,
    )
    const read = await fetch(
      `${f.base}/file?path=${encodeURIComponent(`uploads/figure.${extension}`)}`,
      { headers: { Authorization: `Bearer ${f.owner.token}` } },
    )
    assert.equal(read.status, extension === 'svg' ? 200 : 415)
  }
})

test('a member revoked while an image read is in progress receives no preview bytes', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.project.root, 'figure.png'), png)
  const original = f.workspaces.readDownloadFile.bind(f.workspaces)
  let admit, announce
  const entered = new Promise((resolve) => {
      announce = resolve
    }),
    gate = new Promise((resolve) => {
      admit = resolve
    })
  f.workspaces.readDownloadFile = async (...args) => {
    const file = await original(...args)
    announce()
    await gate
    return file
  }
  const response = f.preview('figure.png', f.viewer)
  await entered
  await f.workspaces.removeMember(f.project.id, f.owner.id, f.viewer.id)
  admit()
  assert.equal((await response).status, 404)
})

test('common exported SVG doctypes are removed only in preview and quoted attributes cannot bypass size checks', async (t) => {
  const f = await fixture(t)
  const source = `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<?xml-stylesheet href="https://external.invalid/style.css"?>\n<!-- drawing -->\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><circle r="5"/></svg><!-- end -->`
  await fs.writeFile(path.join(f.project.root, 'exported.svg'), source)
  const response = await f.preview('exported.svg')
  assert.equal(response.status, 200)
  const rendered = await response.text()
  assert.doesNotMatch(rendered, /DOCTYPE|external\.invalid|xml-stylesheet/i)
  assert.match(rendered, /<circle r="5"\/>/)
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'exported.svg'), 'utf8'),
    source,
  )
  assert.throws(
    () =>
      validateImageBytes(
        'huge.svg',
        Buffer.from('<svg aria-label="a > b" width="20000" height="1"/>'),
      ),
    { status: 413 },
  )
  const html = await sanitizedHtmlPreview(
    '<img src="exported.svg">',
    'index.html',
    async () => ({ content: Buffer.from(source) }),
  )
  const embedded = /base64,([^"]+)/.exec(html)[1]
  assert.doesNotMatch(
    Buffer.from(embedded, 'base64').toString('utf8'),
    /DOCTYPE|xml-stylesheet/i,
  )
})

test('SVG previews allow embedded raster data while retaining a sandbox and blocking script and network sources', async (t) => {
  const f = await fixture(t)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="data:image/png;base64,${png.toString('base64')}" width="100" height="100"/><image href="https://external.invalid/image.png"/><script>fetch('/private-session')</script></svg>`
  await fs.writeFile(path.join(f.project.root, 'heatmap.svg'), source)
  const response = await f.preview('heatmap.svg', f.viewer)
  assert.equal(response.status, 200)
  const policy = new Map(
    response.headers
      .get('content-security-policy')
      .split(';')
      .map((directive) => {
        const [name, ...values] = directive.trim().split(/\s+/)
        return [name, values]
      }),
  )
  assert.deepEqual(
    policy.get('img-src'),
    ['data:'],
    'Native SVG documents can render self-contained raster layers without allowing remote images',
  )
  assert.deepEqual(
    policy.get('default-src'),
    ["'none'"],
    'Script and other unlisted resource sources remain blocked',
  )
  assert.deepEqual(
    policy.get('sandbox'),
    [],
    'No script or same-origin sandbox capability is granted',
  )
  assert.deepEqual(policy.get('form-action'), ["'none'"])
  assert.match(await response.text(), /href="data:image\/png;base64,/)
})
