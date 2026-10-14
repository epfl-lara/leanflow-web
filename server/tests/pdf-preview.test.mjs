import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createStudio } from '../studio.mjs'
import { uploadedFiles } from '../project-import.mjs'
import { validateWorkspaceFilePath } from '../workspaces.mjs'
import { MAX_PDF_FILE_BYTES } from '../../shared/file-previews.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const pdf = Buffer.from(
  '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
  'latin1',
)
const upload = (filename, bytes = pdf) => ({
  path: filename,
  content: bytes.toString('base64'),
  encoding: 'base64',
})

async function fixture(t, files) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-pdf-'))
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async shutdown() {},
    spawn() {
      assert.fail('PDF reads and uploads must not launch workers')
    },
    async run(root, args) {
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true })
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      }
      return { code: 0, stdout: '', stderr: '' }
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
  const project = await studio.workspaces.create('owner', {
    name: 'PDF fixture',
    preset: 'lean',
    ...(files ? { files } : {}),
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  runtime.run = () => assert.fail('PDF access must not run commands')
  const token = (
    await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')
  ).trim()
  const otherToken = 'other-pdf-fixture'
  studio.auth.users.push({
    id: 'other',
    name: 'Other',
    tokenHash: createHash('sha256').update(otherToken).digest('hex'),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth', 'users.json'),
    JSON.stringify(studio.auth.users),
  )
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const endpoint = `/api/projects/${project.id}`
  const request = (url, options = {}, access = token) =>
    fetch(base + endpoint + url, {
      ...options,
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
        ...options.headers,
      },
    })
  const preview = (filename, access) =>
    request(`/file-preview?path=${encodeURIComponent(filename)}`, {}, access)
  return { ...studio, project, dataDir, request, preview, otherToken }
}

test('HTTP PDF preview returns exact bytes and safe headers only to the project owner', async (t) => {
  const f = await fixture(t)
  const filename = 'Proof "notes" ü.PDF'
  await fs.writeFile(path.join(f.project.root, filename), pdf)
  const response = await f.preview(filename)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(
    response.headers.get('content-disposition'),
    'inline; filename="document.pdf"; filename*=UTF-8\'\'Proof%20%22notes%22%20%C3%BC.PDF',
  )
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf)
  assert.equal((await f.preview(filename, null)).status, 401)
  assert.equal((await f.preview(filename, f.otherToken)).status, 404)
  const listed = await (await f.request('/files')).json()
  assert(
    listed.some((file) => file.path === filename && file.size === pdf.length),
  )
})

test('HTTP PDF preview rejects traversal, secrets, symlinks, wrong types and oversized files', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.dataDir, 'outside.pdf'), pdf)
  await fs.symlink(
    path.join(f.dataDir, 'outside.pdf'),
    path.join(f.project.root, 'link.pdf'),
  )
  await fs.symlink(f.dataDir, path.join(f.project.root, 'escape'))
  await fs.writeFile(
    path.join(f.project.root, 'wrong.pdf'),
    '<html>not a PDF</html>',
  )
  await fs.writeFile(path.join(f.project.root, 'unfinished.pdf'), '%PDF-1.7\n')
  await fs.writeFile(path.join(f.project.root, 'large.pdf'), pdf)
  await fs.truncate(
    path.join(f.project.root, 'large.pdf'),
    MAX_PDF_FILE_BYTES + 1,
  )
  await fs.mkdir(path.join(f.project.root, 'folder.pdf'))
  for (const [filename, status] of [
    ['../outside.pdf', 400],
    ['/outside.pdf', 400],
    ['a/../../outside.pdf', 400],
    ['a\\outside.pdf', 400],
    ['.git/private.pdf', 400],
    ['.env/private.pdf', 400],
    ['link.pdf', 403],
    ['escape/outside.pdf', 403],
    ['Main.lean', 415],
    ['wrong.pdf', 415],
    ['unfinished.pdf', 415],
    ['missing.pdf', 404],
    ['large.pdf', 413],
    ['folder.pdf', 400],
  ]) {
    const response = await f.preview(filename)
    assert.equal(response.status, status, filename)
    assert.equal(typeof (await response.json()).error, 'string', filename)
  }
  assert.equal((await f.request('/file-preview')).status, 400)
})

test('PDFs cannot enter text reads, saves, or reviewed text changes, including ASCII PDFs', async (t) => {
  const f = await fixture(t)
  const ascii = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
  await fs.writeFile(path.join(f.project.root, 'ascii.pdf'), ascii)
  assert.equal((await f.request('/file?path=ascii.pdf')).status, 415)
  for (const filename of ['ascii.pdf', 'new.PDF']) {
    const response = await f.request(`/file?path=${filename}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'overwritten', expectedHash: null }),
    })
    assert.equal(response.status, 415, filename)
  }
  for (const after of ['edited', null])
    await assert.rejects(
      f.workspaces.applyChanges(f.project.id, 'owner', [
        {
          path: 'ascii.pdf',
          beforeHash: createHash('sha256').update(ascii).digest('hex'),
          after,
        },
      ]),
      { status: 415 },
    )
  assert.deepEqual(
    await fs.readFile(path.join(f.project.root, 'ascii.pdf')),
    ascii,
  )
  await assert.rejects(fs.stat(path.join(f.project.root, 'new.PDF')), {
    code: 'ENOENT',
  })
})

test('PDF upload and project import retain binary bytes and reject overwrite conflicts', async (t) => {
  const sources = [
    { path: 'lean-toolchain', content: toolchain + '\n' },
    { path: 'lakefile.toml', content: 'name = "fixture"\n' },
    { path: 'Main.lean', content: 'example : True := by trivial\n' },
  ]
  const f = await fixture(t, [...sources, upload('docs/imported.pdf')])
  assert.deepEqual(
    Buffer.from(await (await f.preview('docs/imported.pdf')).arrayBuffer()),
    pdf,
  )
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [upload('docs/uploaded.pdf')] }),
  }
  const response = await f.request('/upload', options)
  assert.equal(response.status, 200, await response.text())
  assert.deepEqual(
    Buffer.from(await (await f.preview('docs/uploaded.pdf')).arrayBuffer()),
    pdf,
  )
  assert.equal((await f.request('/upload', options)).status, 409)
  assert.deepEqual(
    await fs.readFile(path.join(f.project.root, 'docs/uploaded.pdf')),
    pdf,
  )
  const rejected = await f.request('/upload', {
    ...options,
    headers: { ...options.headers, Origin: 'https://unrelated.test' },
    body: JSON.stringify({ files: [upload('cross-origin.pdf')] }),
  })
  assert.equal(rejected.status, 403)
})

test('upload validation admits only bounded canonical PDF base64 alongside UTF-8 source', () => {
  const validated = uploadedFiles(
    [{ path: 'README.md', content: '# Project\n' }, upload('proof.pdf')],
    validateWorkspaceFilePath,
  )
  assert.equal(validated[0].content, '# Project\n')
  assert.deepEqual(validated[1].content, pdf)
  for (const file of [
    upload('data.bin'),
    { path: 'proof.pdf', content: pdf.toString('latin1') },
    { ...upload('proof.pdf'), encoding: 'utf8' },
    { ...upload('proof.pdf'), content: '!invalid!' },
    { ...upload('proof.pdf'), content: pdf.toString('base64') + '\n' },
    upload('proof.pdf', Buffer.from('not PDF')),
    upload('proof.pdf', Buffer.from('%PDF-1.7\nmissing end marker')),
  ])
    assert.throws(() => uploadedFiles([file], validateWorkspaceFilePath), {
      status: 415,
    })
  const maximum = Buffer.alloc(MAX_PDF_FILE_BYTES, 32)
  pdf.copy(maximum)
  maximum.write('%%EOF\n', maximum.length - 6)
  assert.equal(
    uploadedFiles(
      [upload('maximum.pdf', maximum)],
      validateWorkspaceFilePath,
    )[0].content.length,
    MAX_PDF_FILE_BYTES,
  )
  const tooLarge = Buffer.concat([maximum, Buffer.from('\n')])
  assert.throws(
    () =>
      uploadedFiles([upload('large.pdf', tooLarge)], validateWorkspaceFilePath),
    { status: 413 },
  )
  assert.throws(
    () =>
      uploadedFiles(
        [
          upload('a.pdf', maximum),
          upload('b.pdf', maximum),
          { path: 'README.md', content: 'x' },
        ],
        validateWorkspaceFilePath,
      ),
    { status: 413 },
  )
})
