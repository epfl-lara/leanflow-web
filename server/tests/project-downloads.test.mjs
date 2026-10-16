import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import JSZip from 'jszip'
import { createStudio } from '../studio.mjs'
import {
  createProjectDownload,
  downloadDisposition,
} from '../project-downloads.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-download-'))
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async shutdown() {},
    spawn() {
      assert.fail('Downloads must not launch workers')
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
    name: 'Proof "notes" ü',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  runtime.run = () => assert.fail('Downloads must not run commands')
  const token = (
    await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')
  ).trim()
  const otherToken = 'other-download-fixture'
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
  const request = (query = '', access = token) =>
    fetch(`${base}/api/projects/${project.id}/download${query}`, {
      signal: AbortSignal.timeout(5000),
      headers: access ? { Authorization: `Bearer ${access}` } : {},
    })
  const download = (filename, access) =>
    request(`?path=${encodeURIComponent(filename)}`, access)
  return { ...studio, project, dataDir, request, download, otherToken }
}

test('HTTP file downloads preserve binary bytes and safe Unicode filenames with owner authorization', async (t) => {
  const f = await fixture(t)
  const filename = 'Proof "notes" ü.bin'
  const content = Buffer.from([0, 1, 2, 127, 128, 254, 255])
  await fs.writeFile(path.join(f.project.root, filename), content)
  const response = await f.download(filename)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="Proof _notes_ _.bin"; filename*=UTF-8\'\'Proof%20%22notes%22%20%C3%BC.bin',
  )
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
  assert.equal((await f.download(filename, null)).status, 401)
  assert.equal((await f.download(filename, f.otherToken)).status, 404)
  assert.equal((await f.request('', null)).status, 401)
  assert.equal((await f.request('', f.otherToken)).status, 404)
  assert.equal((await f.download('Missing.lean')).status, 404)
  assert.equal((await f.request('?path=Main.lean&path=Other.lean')).status, 400)
})

test('HTTP downloads reject secret paths, traversal, symbolic links, special files and oversized files', async (t) => {
  const f = await fixture(t)
  const outside = path.join(f.dataDir, 'private.lean')
  await fs.writeFile(outside, 'private host data')
  await fs.symlink(outside, path.join(f.project.root, 'Link.lean'))
  await fs.symlink(f.dataDir, path.join(f.project.root, 'Linked'))
  await fs.symlink(
    path.join(f.project.root, 'Main.lean'),
    path.join(f.project.root, 'Internal.lean'),
  )
  await fs.writeFile(path.join(f.project.root, '.env'), 'private environment')
  for (const filename of [
    '../private.lean',
    '/etc/passwd',
    'Main/../Main.lean',
    '.env',
    '.env.local',
    '.git/config',
    '.ssh/id_rsa',
    'settings.local.json',
    'private.key',
    '.lake/build/Main.olean',
  ]) {
    const response = await f.download(filename)
    assert.equal(response.status, 400, filename)
    assert(!JSON.stringify(await response.json()).includes('private host data'))
  }
  for (const filename of ['Link.lean', 'Linked/private.lean', 'Internal.lean'])
    assert.equal((await f.download(filename)).status, 403, filename)
  assert.equal(
    spawnSync('mkfifo', [path.join(f.project.root, 'Pipe.lean')]).status,
    0,
  )
  assert.equal((await f.download('Pipe.lean')).status, 400)
  await fs.mkdir(path.join(f.project.root, 'Main'))
  assert.equal((await f.download('Main')).status, 400)
  const big = await fs.open(path.join(f.project.root, 'Large.bin'), 'w')
  await big.truncate(32 * 1024 * 1024 + 1)
  await big.close()
  assert.equal((await f.download('Large.bin')).status, 413)
})

test('HTTP project ZIP preserves sources, empty folders and exact Lean pins while excluding private files and dependencies', async (t) => {
  const f = await fixture(t)
  const files = new Map([
    [
      'lake-manifest.json',
      Buffer.from(
        '{"version":"1.1.0","packages":[{"name":"library","rev":"pinned-revision"}]}\n',
      ),
    ],
    [
      'Proofs/Theorem.lean',
      Buffer.from('theorem example_proof : True := by trivial\n'),
    ],
    ['assets/diagram.bin', Buffer.from([0, 255, 0, 128])],
    ['README.md', Buffer.from('# Source project\n')],
    ['.git/config', Buffer.from('private Git credentials')],
    ['.env', Buffer.from('private environment')],
    ['Nested/settings.local.json', Buffer.from('private settings')],
    ['Nested/auth.json', Buffer.from('private auth')],
    ['Nested/credentials/token', Buffer.from('private credentials')],
    ['.lake/build/Main.olean', Buffer.from('build cache')],
    ['.lake/packages/library/Library.lean', Buffer.from('shared dependency')],
    ['.runtime/output.log', Buffer.from('private runtime')],
    ['node_modules/package/index.js', Buffer.from('dependency')],
  ])
  for (const [filename, content] of files) {
    await fs.mkdir(path.dirname(path.join(f.project.root, filename)), {
      recursive: true,
    })
    await fs.writeFile(path.join(f.project.root, filename), content)
  }
  await fs.mkdir(path.join(f.project.root, 'Empty'), { recursive: true })
  await fs.symlink(f.dataDir, path.join(f.project.root, 'Linked'))
  await fs.symlink(
    path.join(f.project.root, 'Main.lean'),
    path.join(f.project.root, 'Alias.lean'),
  )
  assert.equal(
    spawnSync('mkfifo', [path.join(f.project.root, 'Pipe.lean')]).status,
    0,
  )
  const response = await f.request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/zip')
  assert.equal(
    response.headers.get('content-disposition'),
    downloadDisposition(`${f.project.name}.zip`),
  )
  const zip = await JSZip.loadAsync(await response.arrayBuffer())
  for (const filename of [
    'Main.lean',
    'lean-toolchain',
    'lakefile.toml',
    'lake-manifest.json',
    '.gitignore',
    'Proofs/Theorem.lean',
    'assets/diagram.bin',
    'README.md',
  ])
    assert.deepEqual(
      await zip.file(filename).async('nodebuffer'),
      await fs.readFile(path.join(f.project.root, filename)),
      filename,
    )
  assert.equal(zip.files['Empty/'].dir, true)
  assert.equal(
    (await zip.file('lean-toolchain').async('text')).trim(),
    toolchain,
  )
  for (const filename of Object.keys(zip.files))
    assert(
      !/(?:^|\/)(?:\.git|\.lake|\.env|settings\.local\.json|auth\.json|credentials|\.runtime|node_modules|Linked|Alias\.lean|Pipe\.lean)(?:\/|$)/.test(
        filename,
      ),
      filename,
    )
  // Individual read-only dependency sources remain downloadable without
  // embedding the entire shared dependency cache in the project archive.
  const dependency = await f.download('.lake/packages/library/Library.lean')
  assert.equal(dependency.status, 200)
  assert.equal(await dependency.text(), 'shared dependency')
})

test('project exports stop at byte, entry, scan and cancellation boundaries', async (t) => {
  const f = await fixture(t)
  const exportWith = (limits, signal) =>
    createProjectDownload(f.workspaces, f.project.id, 'owner', undefined, {
      limits,
      signal,
    })
  await assert.rejects(exportWith({ archiveBytes: 1 }), { status: 413 })
  await assert.rejects(exportWith({ fileBytes: 1 }), { status: 413 })
  await assert.rejects(exportWith({ entries: 1 }), { status: 413 })
  await assert.rejects(exportWith({ scanEntries: 1 }), { status: 413 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(exportWith({}, controller.signal), { status: 408 })
  const original = f.workspaces.readDownloadFile.bind(f.workspaces)
  const duringRead = new AbortController()
  f.workspaces.readDownloadFile = async (...args) => {
    duringRead.abort()
    return original(...args)
  }
  await assert.rejects(exportWith({}, duringRead.signal), { status: 408 })
})

test('file and project downloads reject a workspace root replaced by a symbolic link', async (t) => {
  const f = await fixture(t)
  const original = `${f.project.root}-original`
  await fs.rename(f.project.root, original)
  await fs.symlink(original, f.project.root)
  try {
    assert.equal((await f.download('Main.lean')).status, 409)
    assert.equal((await f.request()).status, 409)
  } finally {
    await fs.unlink(f.project.root)
    await fs.rename(original, f.project.root)
  }
})

test('download admission protects generation and releases its slot after success or failure', async (t) => {
  const f = await fixture(t)
  const original = f.workspaces.readDownloadFile.bind(f.workspaces)
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let unblock
  const blocked = new Promise((resolve) => {
    unblock = resolve
  })
  f.workspaces.readDownloadFile = async (...args) => {
    entered()
    await blocked
    return original(...args)
  }
  const pending = f.download('Main.lean')
  await started
  const busy = await f.request()
  assert.equal(busy.status, 429)
  assert.equal(busy.headers.get('retry-after'), '1')
  unblock()
  assert.equal((await pending).status, 200)
  f.workspaces.readDownloadFile = original
  assert.equal((await f.download('Missing.lean')).status, 404)
  assert.equal((await f.download('Main.lean')).status, 200)
})

test('cancelling during ZIP output rejects safely and leaves the process usable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-cancel-zip-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  // Keep an unexpected throw inside the ZIP library isolated from the test
  // runner. Cancellation must remain a rejected request, not a process crash.
  const checked = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict'
      import fs from 'node:fs/promises'
      import path from 'node:path'
      import JSZip from 'jszip'
      import { createProjectDownload } from ${JSON.stringify(new URL('../project-downloads.mjs', import.meta.url).href)}
      const root = process.argv[1]
      const workspaces = {
        get: () => ({ root, name: 'Cancellation fixture' }),
        readDownloadFile: async (_id, _owner, filename) => ({
          content: await fs.readFile(path.join(root, filename)), mode: 0o600,
        }),
      }
      const generate = JSZip.prototype.generateInternalStream
      for (const content of [null, 'x'.repeat(1024 * 1024)]) {
        if (content) await fs.writeFile(path.join(root, 'Main.lean'), content)
        const controller = new AbortController()
        let emitted = false
        JSZip.prototype.generateInternalStream = function (...args) {
          const stream = generate.apply(this, args)
          stream.on('data', () => {
            if (!emitted) {
              emitted = true
              controller.abort()
            }
          })
          return stream
        }
        await assert.rejects(
          createProjectDownload(workspaces, 'project', 'owner', undefined, { signal: controller.signal }),
          { status: 408 },
        )
        assert.equal(emitted, true)
      }
      JSZip.prototype.generateInternalStream = generate
      const download = await createProjectDownload(workspaces, 'project', 'owner')
      const zip = await JSZip.loadAsync(download.content)
      assert.equal((await zip.file('Main.lean').async('text')).length, 1024 * 1024)
      console.log('Cancellation rejected safely; subsequent ZIP succeeded.')
    `,
      root,
    ],
    { encoding: 'utf8', timeout: 10000 },
  )
  assert.equal(checked.error, undefined)
  assert.equal(checked.status, 0, checked.stderr)
  assert.match(checked.stdout, /Cancellation rejected safely/)
})
