import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createStudio } from '../studio.mjs'
import { TexBuildManager } from '../tex-builds.mjs'
import { uploadedFiles } from '../project-import.mjs'
import { validateWorkspaceFilePath } from '../workspaces.mjs'
import { TEX_FILE_MAX_BYTES, TEX_SOURCE_MAX_FILES } from '../../shared/tex.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64',
)
const digest = (content) => createHash('sha256').update(content).digest('hex')

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-tex-'))
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async shutdown() {},
    texInfo: async () => ({ available: true, engines: ['pdflatex'] }),
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
    async runTex(source, output, options) {
      options.signal.throwIfAborted()
      await fs.writeFile(path.join(output, 'document.pdf'), pdf)
      await fs.writeFile(
        path.join(output, 'document.txt'),
        'Compiled document text',
      )
      await fs.writeFile(
        path.join(output, 'result.json'),
        JSON.stringify({
          schema: 1,
          success: true,
          diagnostics: [],
          versions: { pdflatex: 'fixture' },
        }),
      )
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
    name: 'TeX fixture',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  await fs.writeFile(
    path.join(project.root, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\\input{section}\\end{document}',
  )
  await fs.writeFile(path.join(project.root, 'section.tex'), 'Hello')
  const token = (
    await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')
  ).trim()
  const otherToken = 'other-tex-fixture'
  studio.auth.users.push({
    id: 'other',
    name: 'Other',
    tokenHash: digest(otherToken),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth', 'users.json'),
    JSON.stringify(studio.auth.users),
  )
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const endpoint = `/api/projects/${project.id}`
  const request = (url, options = {}, access = token) =>
    fetch(base + (url.startsWith('/api/') ? url : endpoint + url), {
      ...options,
      signal: AbortSignal.timeout(10000),
      headers: {
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
        ...options.headers,
      },
    })
  const post = (url, body, access) =>
    request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      access,
    )
  const start = (input = { rootFile: 'main.tex' }, options) =>
    studio.texBuilds.start('owner', project.id, input, options)
  const compile = async () => studio.texBuilds.wait('owner', (await start()).id)
  return {
    ...studio,
    dataDir,
    project,
    request,
    post,
    start,
    compile,
    otherToken,
  }
}

test('multi-file TeX uses a bounded immutable capture with exact hashes and protected binary inputs', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.project.root, 'figure.png'), png)
  await fs.writeFile(path.join(f.project.root, '.env'), 'SECRET=private')
  await fs.mkdir(path.join(f.project.root, '.lake', 'secret'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(f.project.root, '.lake', 'secret', 'private.tex'),
    'PRIVATE',
  )
  await fs.writeFile(path.join(f.dataDir, 'outside.tex'), 'OUTSIDE')
  await fs.symlink(
    path.join(f.dataDir, 'outside.tex'),
    path.join(f.project.root, 'unsafe.tex'),
  )
  const run = f.runtime.runTex
  f.runtime.runTex = async (source, output, options) => {
    assert.deepEqual((await fs.readdir(source)).sort(), [
      'figure.png',
      'main.tex',
      'section.tex',
    ])
    assert.deepEqual(await fs.readFile(path.join(source, 'figure.png')), png)
    await fs.writeFile(
      path.join(f.project.root, 'section.tex'),
      'Saved during build',
    )
    assert.equal(
      await fs.readFile(path.join(source, 'section.tex'), 'utf8'),
      'Hello',
    )
    return run(source, output, options)
  }
  const before = (await f.texBuilds.state('owner', f.project.id))
    .workspaceRevision
  const job = await f.compile()
  assert.equal(job.status, 'completed')
  assert.equal(job.workspaceRevision, before)
  assert.notEqual(
    (await f.texBuilds.state('owner', f.project.id)).workspaceRevision,
    job.workspaceRevision,
  )
  assert.deepEqual((await f.texBuilds.readPdf('owner', job.id)).content, pdf)
  assert.equal(
    (await f.texBuilds.readText('owner', job.id)).content,
    'Compiled document text',
  )
  const stored = f.events.getMetadata(job.id)
  assert.equal(stored.inputs, undefined)
  const captured = JSON.parse(
    await fs.readFile(
      path.join(f.dataDir, 'tex-builds', job.id, 'inputs.json'),
      'utf8',
    ),
  )
  assert.equal(
    captured.files.find((file) => file.path === 'figure.png').hash,
    digest(png),
  )
  assert.equal(stored.sourceRevision, digest(JSON.stringify(captured.files)))
  assert(!Object.hasOwn(job, 'owner'))
  assert(!JSON.stringify(job).includes(f.dataDir))
  await assert.rejects(
    fs.stat(path.join(f.dataDir, 'tex-builds', job.id, 'source')),
    { code: 'ENOENT' },
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'section.tex'), 'utf8'),
    'Saved during build',
  )
  assert.equal(
    (await fs.readdir(f.project.root)).some((name) =>
      /\.(?:aux|log|fls|fdb_latexmk)$/.test(name),
    ),
    false,
  )
})

test('TeX HTTP endpoints authenticate ownership and paths, return exact PDF bytes, and reject cross-project artifacts', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request('/tex', {}, null)).status, 401)
  assert.equal((await f.request('/tex', {}, f.otherToken)).status, 404)
  assert.equal(
    (await f.post('/tex/build', { rootFile: 'main.tex' }, f.otherToken)).status,
    404,
  )
  for (const body of [
    { rootFile: '../main.tex' },
    { rootFile: '/main.tex' },
    { rootFile: '.env/a.tex' },
    { rootFile: 'a\\main.tex' },
    { rootFile: 'Main.lean' },
    { rootFile: 'main.tex', engine: 'xelatex' },
    { rootFile: 'main.tex', sourceRoot: '/etc' },
  ])
    assert.equal(
      (await f.post('/tex/build', body)).status,
      400,
      JSON.stringify(body),
    )
  const response = await f.post('/tex/build', {
    rootFile: 'main.tex',
    engine: 'pdflatex',
  })
  assert.equal(response.status, 202)
  const job = await f.texBuilds.wait('owner', (await response.json()).id)
  const preview = await f.request(job.pdf.url)
  assert.equal(preview.status, 200)
  assert.equal(preview.headers.get('content-type'), 'application/pdf')
  assert.equal(preview.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), pdf)
  assert.equal((await f.request(job.pdf.url, {}, f.otherToken)).status, 404)
  assert.equal(
    (await f.request(job.pdf.url.replace(f.project.id, 'other-project')))
      .status,
    404,
  )
  const state = await (await f.request('/tex')).json()
  assert.equal(state.build.id, job.id)
  assert.equal(state.lastSuccessful.id, job.id)
})

test('failed rebuilds retain the last successful PDF, map diagnostics, and never publish failed artifacts', async (t) => {
  const f = await fixture(t)
  const success = await f.compile()
  f.runtime.runTex = async (source, output, options) => {
    options.onOutput('main.tex:3: Undefined control sequence\n')
    await fs.writeFile(path.join(output, 'document.pdf'), pdf)
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify({
        success: false,
        diagnostics: [
          {
            severity: 'error',
            message: 'Undefined control sequence',
            file: 'main.tex',
            line: 3,
          },
          {
            severity: 'warning',
            message: 'Reference missing',
            file: '/etc/private',
            line: 7,
          },
        ],
      }),
    )
    return { code: 1 }
  }
  const failed = await f.compile()
  assert.equal(failed.status, 'failed')
  assert.equal(failed.pdf, undefined)
  assert.deepEqual(failed.diagnostics[0], {
    severity: 'error',
    message: 'Undefined control sequence',
    path: 'main.tex',
    line: 3,
  })
  assert.equal(failed.diagnostics[1].path, undefined)
  assert.match(failed.log, /Undefined control/)
  const state = await f.texBuilds.state('owner', f.project.id)
  assert.equal(state.build.id, failed.id)
  assert.equal(state.lastSuccessful.id, success.id)
  assert.deepEqual(
    (await f.texBuilds.readPdf('owner', success.id)).content,
    pdf,
  )
  await assert.rejects(f.texBuilds.readPdf('owner', failed.id), { status: 404 })
})

test('assistant mutation endpoints cannot relabel or stop a TeX build', async (t) => {
  const f = await fixture(t)
  const started = new Promise((resolve) => {
    f.runtime.runTex = async (_source, _output, { signal }) => {
      resolve()
      await new Promise((stop) =>
        signal.addEventListener('abort', stop, { once: true }),
      )
      signal.throwIfAborted()
    }
  })
  const build = await f.start()
  await started
  for (const action of ['stop', 'undo', 'apply', 'messages']) {
    const response = await f.post(`/api/runs/${build.id}/${action}`, {})
    assert.equal(response.status, 400, action)
    assert.equal(f.texBuilds.get('owner', build.id).status, 'running')
  }
  assert.equal((await f.post(`/api/jobs/${build.id}/stop`, {})).status, 400)
  assert.equal(f.texBuilds.get('owner', build.id).status, 'running')
  const stopped = await f.post(`/tex/builds/${build.id}/stop`, {})
  assert.equal(stopped.status, 200)
  assert.equal((await stopped.json()).status, 'cancelled')
})

async function holdBuild(f) {
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let finished = false
  f.runtime.runTex = async (source, output, { signal }) => {
    entered()
    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true })
      if (signal.aborted) resolve()
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    finished = true
    signal.throwIfAborted()
  }
  const job = await f.start()
  await started
  return { job, finished: () => finished }
}

test('TeX build cancellation waits for worker teardown and permits a fresh build only afterward', async (t) => {
  const f = await fixture(t)
  const success = f.runtime.runTex
  const held = await holdBuild(f)
  await assert.rejects(f.start(), { status: 409 })
  const stop = f.texBuilds.stop('owner', held.job.id)
  assert.equal(held.finished(), false)
  assert.equal((await stop).status, 'cancelled')
  assert.equal(held.finished(), true)
  f.runtime.runTex = success
  assert.equal((await f.compile()).status, 'completed')
})

test('TeX deadline includes waiting for a worker, and shutdown aborts pending builds', async (t) => {
  const f = await fixture(t)
  f.texBuilds.timeoutMs = 50
  const held = await holdBuild(f)
  const result = await f.texBuilds.wait('owner', held.job.id)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /time limit/)
  assert.equal(held.finished(), true)
  f.texBuilds.timeoutMs = 5000
  const second = await holdBuild(f)
  await f.texBuilds.shutdown()
  assert.equal(second.finished(), true)
  assert.equal(f.texBuilds.get('owner', second.job.id).status, 'cancelled')
  await assert.rejects(f.start(), { status: 503 })
})

test('archiving a project stops TeX workers first; permanent deletion removes retained build artifacts', async (t) => {
  const f = await fixture(t)
  const done = await f.compile()
  const held = await holdBuild(f)
  assert.equal((await f.post('/trash', {})).status, 409)
  const response = await f.post('/trash', { stopActive: true })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(held.finished(), true)
  const entry = await response.json()
  const deleted = await f.post(`/api/trash/${entry.trashId}/delete-forever`, {})
  assert.equal(deleted.status, 200, await deleted.clone().text())
  await assert.rejects(fs.stat(path.join(f.dataDir, 'tex-builds', done.id)), {
    code: 'ENOENT',
  })
  assert.equal(f.events.projectMetadata('owner', f.project.id).length, 0)
})

test('agent TeX builds only accept an owned managed snapshot and do not replace the project PDF', async (t) => {
  const f = await fixture(t)
  const success = await f.compile()
  const snapshot = await f.workspaces.snapshot(
    f.project.id,
    'owner',
    'tex-agent',
  )
  await fs.writeFile(
    path.join(snapshot.root, 'section.tex'),
    'Candidate change',
  )
  const agent = await f.texBuilds.wait(
    'owner',
    (
      await f.start(undefined, {
        sourceRoot: snapshot.root,
        runId: 'tex-agent',
        origin: 'agent',
      })
    ).id,
  )
  assert.equal(agent.status, 'completed')
  assert.notEqual(agent.sourceRevision, success.sourceRevision)
  assert.equal(
    (await f.texBuilds.state('owner', f.project.id)).build.id,
    success.id,
  )
  for (const options of [
    { sourceRoot: f.project.root, runId: 'tex-agent' },
    { sourceRoot: snapshot.root, runId: 'wrong-run' },
    { sourceRoot: '/etc', runId: 'tex-agent' },
  ]) {
    const job = await f.texBuilds.wait(
      'owner',
      (await f.start(undefined, options)).id,
    )
    assert.equal(job.status, 'failed')
    assert.equal(job.pdf, undefined)
  }
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'section.tex'), 'utf8'),
    'Hello',
  )
})

test('TeX rejects missing or symlinked roots, oversized inputs, and source captures above the file-count limit', async (t) => {
  const f = await fixture(t)
  await fs.symlink(
    path.join(f.project.root, 'main.tex'),
    path.join(f.project.root, 'linked.tex'),
  )
  for (const rootFile of ['missing.tex', 'linked.tex']) {
    const job = await f.texBuilds.wait(
      'owner',
      (await f.start({ rootFile })).id,
    )
    assert.equal(job.status, 'failed')
    assert.match(job.error, /root TeX file/)
  }
  const big = path.join(f.project.root, 'big.dat')
  await fs.writeFile(big, '')
  await fs.truncate(big, TEX_FILE_MAX_BYTES + 1)
  assert.match((await f.compile()).error, /16 MiB/)
  await fs.rm(big)
  const inputDir = path.join(f.project.root, 'many')
  await fs.mkdir(inputDir)
  await Promise.all(
    Array.from({ length: TEX_SOURCE_MAX_FILES }, (_, index) =>
      fs.writeFile(path.join(inputDir, `${index}.tex`), 'x'),
    ),
  )
  const limited = await f.compile()
  assert.equal(limited.status, 'failed')
  assert.match(limited.error, /4,096/)
})

test('generated artifact reads reject symlink escapes, oversized outputs, and post-build mutations', async (t) => {
  const f = await fixture(t)
  const job = await f.compile()
  const output = path.join(f.dataDir, 'tex-builds', job.id, 'output')
  await fs.writeFile(
    path.join(output, 'document.pdf'),
    Buffer.from('%PDF-1.7\nchanged\n%%EOF\n'),
  )
  await assert.rejects(f.texBuilds.readPdf('owner', job.id), { status: 409 })
  await fs.writeFile(path.join(output, 'document.txt'), 'changed')
  await assert.rejects(f.texBuilds.readText('owner', job.id), { status: 409 })
  await fs.rm(path.join(output, 'document.pdf'))
  await fs.symlink(
    path.join(f.project.root, 'main.tex'),
    path.join(output, 'document.pdf'),
  )
  await assert.rejects(f.texBuilds.readPdf('owner', job.id), { status: 403 })
  f.runtime.runTex = async (source, directory) => {
    await fs.writeFile(path.join(directory, 'document.pdf'), pdf)
    await fs.truncate(
      path.join(directory, 'document.pdf'),
      16 * 1024 * 1024 + 1,
    )
    return { code: 0 }
  }
  assert.equal((await f.compile()).status, 'failed')
})

test('artifact retention is bounded and retains the latest successful project PDF across failures and candidate builds', async (t) => {
  const f = await fixture(t)
  f.texBuilds.retainedBuilds = 2
  const first = await f.compile()
  const second = await f.compile()
  const third = await f.compile()
  await assert.rejects(f.texBuilds.readPdf('owner', first.id), { status: 404 })
  assert.deepEqual((await f.texBuilds.readPdf('owner', second.id)).content, pdf)
  const snapshot = await f.workspaces.snapshot(
    f.project.id,
    'owner',
    'retention-agent',
  )
  for (let i = 0; i < 3; i++)
    await f.texBuilds.wait(
      'owner',
      (
        await f.start(undefined, {
          sourceRoot: snapshot.root,
          runId: snapshot.runId,
        })
      ).id,
    )
  assert.equal(
    (await f.texBuilds.state('owner', f.project.id)).lastSuccessful.id,
    third.id,
  )
  assert.deepEqual((await f.texBuilds.readPdf('owner', third.id)).content, pdf)
  const retained = await fs.readdir(path.join(f.dataDir, 'tex-builds'))
  assert(retained.length <= 4)
})

test('PNG and JPEG imports preserve bytes, are excluded from text mutation, and are retained unchanged in snapshots', async (t) => {
  const f = await fixture(t)
  const jpg = Buffer.from([255, 216, 255, 217])
  const uploads = [
    { path: 'image.png', content: png.toString('base64'), encoding: 'base64' },
    { path: 'image.jpg', content: jpg.toString('base64'), encoding: 'base64' },
  ]
  const response = await f.post('/upload', { files: uploads })
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(
    await fs.readFile(path.join(f.project.root, 'image.png')),
    png,
  )
  assert.deepEqual(
    await fs.readFile(path.join(f.project.root, 'image.jpg')),
    jpg,
  )
  assert.equal((await f.post('/upload', { files: uploads })).status, 409)
  assert.equal((await f.request('/file?path=image.png')).status, 415)
  await assert.rejects(
    f.workspaces.writeFile(
      f.project.id,
      'owner',
      'image.jpg',
      'text',
      digest(jpg),
    ),
    { status: 415 },
  )
  const snapshot = await f.workspaces.snapshot(
    f.project.id,
    'owner',
    'image-agent',
  )
  assert.deepEqual(await f.workspaces.changes(snapshot), [])
  await fs.writeFile(
    path.join(snapshot.root, 'image.png'),
    'ASCII image mutation',
  )
  await assert.rejects(f.workspaces.changes(snapshot), { status: 409 })
  for (const file of [
    { ...uploads[0], content: '!!!!' },
    { ...uploads[0], path: 'image.svg' },
    { path: 'image.png', content: 'text' },
    { ...uploads[0], content: Buffer.from('not image').toString('base64') },
  ])
    assert.throws(() => uploadedFiles([file], validateWorkspaceFilePath), {
      status: 415,
    })
})

test('missing TeX worker is actionable and does not prevent existing Lean project access', async (t) => {
  const f = await fixture(t)
  delete f.runtime.runTex
  const state = await (await f.request('/tex')).json()
  assert.equal(state.available, false)
  assert.match(state.error, /administrator.*TeX worker image/)
  assert.equal(
    (await f.post('/tex/build', { rootFile: 'main.tex' })).status,
    503,
  )
  assert.equal((await f.request('/file?path=Main.lean')).status, 200)
})

test('startup removes interrupted source captures and failed output without following substituted storage directories', async (t) => {
  const f = await fixture(t)
  const interrupted = f.events.create('owner', {
    kind: 'tex',
    projectId: f.project.id,
    rootFile: 'main.tex',
    engine: 'pdflatex',
  })
  f.events.updateMetadata(interrupted.id, { status: 'interrupted' })
  const directory = path.join(f.dataDir, 'tex-builds', interrupted.id)
  await fs.mkdir(path.join(directory, 'source'), { recursive: true })
  await fs.mkdir(path.join(directory, 'output'))
  await fs.writeFile(
    path.join(directory, 'source', 'main.tex'),
    'interrupted input',
  )
  await fs.writeFile(path.join(directory, 'output', 'document.pdf'), pdf)
  const manager = new TexBuildManager({
    dataDir: f.dataDir,
    events: f.events,
    runtime: f.runtime,
    workspaces: f.workspaces,
  })
  await manager.init()
  for (const part of ['source', 'output'])
    await assert.rejects(fs.stat(path.join(directory, part)), {
      code: 'ENOENT',
    })
  const outside = path.join(f.dataDir, 'outside-storage')
  await fs.mkdir(path.join(outside, 'source'), { recursive: true })
  await fs.writeFile(path.join(outside, 'source', 'keep.tex'), 'preserve')
  await fs.rm(directory, { recursive: true })
  await fs.symlink(outside, directory)
  await assert.rejects(manager.init(), { status: 403 })
  assert.equal(
    await fs.readFile(path.join(outside, 'source', 'keep.tex'), 'utf8'),
    'preserve',
  )
})

test('PDF text availability, page counts and extraction limits remain explicit', async (t) => {
  const f = await fixture(t)
  const run = f.runtime.runTex
  f.runtime.runTex = async (source, output, options) => {
    const result = await run(source, output, options)
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify({
        success: true,
        textAvailable: true,
        textTruncated: true,
        pageCount: 300,
        diagnostics: [],
      }),
    )
    return result
  }
  const job = await f.compile()
  assert.equal(job.status, 'completed')
  assert.equal(job.textAvailable, true)
  assert.equal(job.textTruncated, true)
  assert.equal(job.pageCount, 300)
  assert.equal(
    (await f.texBuilds.readText('owner', job.id)).textTruncated,
    true,
  )
  f.runtime.runTex = async (source, output, options) => {
    const result = await run(source, output, options)
    await fs.writeFile(path.join(output, 'document.txt'), '')
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify({ success: true, textAvailable: false, diagnostics: [] }),
    )
    return result
  }
  const unavailable = await f.compile()
  assert.equal(unavailable.status, 'completed')
  assert.equal(unavailable.textAvailable, false)
  await assert.rejects(f.texBuilds.readText('owner', unavailable.id), {
    status: 404,
  })
})

test('TeX starts cannot pass project-stop guards or an archive completed during the availability check', async (t) => {
  const f = await fixture(t)
  let entered, release
  const stopping = new Promise((resolve) => {
    entered = resolve
  })
  const teardown = new Promise((resolve) => {
    release = resolve
  })
  const originalStop = f.texBuilds.stopProject.bind(f.texBuilds)
  f.texBuilds.stopProject = async (...args) => {
    entered()
    await teardown
    return originalStop(...args)
  }
  const archive = f.post('/trash', { stopActive: true })
  await stopping
  await assert.rejects(f.start(), { status: 409 })
  release()
  assert.equal((await archive).status, 200)
  assert.equal(
    f.events
      .projectMetadata('owner', f.project.id)
      .filter((job) => job.kind === 'tex').length,
    0,
  )

  const second = await fixture(t)
  let enteredInfo, releaseInfo
  const checking = new Promise((resolve) => {
    enteredInfo = resolve
  })
  const available = new Promise((resolve) => {
    releaseInfo = resolve
  })
  second.runtime.texInfo = async () => {
    enteredInfo()
    await available
    return { available: true }
  }
  const starting = second.start()
  // Attach the rejection handler before letting the deferred start resume.
  const rejected = assert.rejects(starting, { status: 404 })
  await checking
  assert.equal((await second.post('/trash', { stopActive: true })).status, 200)
  releaseInfo()
  await rejected
  assert.equal(
    second.events
      .projectMetadata('owner', second.project.id)
      .filter((job) => job.kind === 'tex').length,
    0,
  )
})

test('selected TeX folders exclude unrelated references from captures and stale fingerprints', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.project.root, 'paper', 'figures'), {
    recursive: true,
  })
  await fs.mkdir(path.join(f.project.root, 'references'))
  await fs.writeFile(
    path.join(f.project.root, 'paper', 'main.tex'),
    '\\input{section}',
  )
  await fs.writeFile(
    path.join(f.project.root, 'paper', 'section.tex'),
    'Scoped document',
  )
  for (const extension of ['tikz', 'pgf', 'ltx', 'bbl'])
    await fs.writeFile(
      path.join(f.project.root, 'paper', `input.${extension}`),
      'input',
    )
  await fs.writeFile(
    path.join(f.project.root, 'paper', 'figures', 'figure.png'),
    png,
  )
  const unrelated = path.join(f.project.root, 'references', 'large.pdf')
  await fs.writeFile(unrelated, '')
  await fs.truncate(unrelated, 80 * 1024 * 1024)
  const run = f.runtime.runTex
  f.runtime.runTex = async (source, output, options) => {
    assert.deepEqual(await fs.readdir(source), ['paper'])
    assert.equal(
      await fs.readFile(path.join(source, 'paper', 'section.tex'), 'utf8'),
      'Scoped document',
    )
    for (const extension of ['tikz', 'pgf', 'ltx', 'bbl'])
      assert.equal(
        await fs.readFile(
          path.join(source, 'paper', `input.${extension}`),
          'utf8',
        ),
        'input',
      )
    return run(source, output, options)
  }
  const job = await f.texBuilds.wait(
    'owner',
    (await f.start({ rootFile: 'paper/main.tex' })).id,
  )
  assert.equal(job.status, 'completed')
  const state = async () =>
    (await f.request('/tex?rootFile=paper%2Fmain.tex')).json()
  assert.equal((await state()).workspaceRevision, job.workspaceRevision)
  await fs.writeFile(
    path.join(f.project.root, 'section.tex'),
    'Unrelated source change',
  )
  assert.equal((await state()).workspaceRevision, job.workspaceRevision)
  await fs.writeFile(
    path.join(f.project.root, 'paper', 'section.tex'),
    'Related source change',
  )
  assert.notEqual((await state()).workspaceRevision, job.workspaceRevision)
  assert.equal((await f.request('/tex?rootFile=..%2Fmain.tex')).status, 400)
  assert.equal((await f.request('/tex?rootFile=Main.lean')).status, 400)
})

test('active agent builds are visible and stoppable without replacing the last project PDF', async (t) => {
  const f = await fixture(t)
  const success = await f.compile()
  const snapshot = await f.workspaces.snapshot(
    f.project.id,
    'owner',
    'active-agent',
  )
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  f.runtime.runTex = async (source, output, { signal }) => {
    entered()
    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true })
      if (signal.aborted) resolve()
    })
    signal.throwIfAborted()
  }
  const agent = await f.start(undefined, {
    sourceRoot: snapshot.root,
    runId: snapshot.runId,
    origin: 'agent',
  })
  await started
  const state = await f.texBuilds.state('owner', f.project.id)
  assert.equal(state.activeBuild.id, agent.id)
  assert.equal(state.activeBuild.origin, 'agent')
  assert.equal(state.lastSuccessful.id, success.id)
  assert.equal(state.build.id, success.id)
  assert.equal(state.build.log, '')
  assert.equal((await f.post(`/tex/builds/${agent.id}/stop`, {})).status, 200)
  assert.equal(
    (await f.texBuilds.state('owner', f.project.id)).activeBuild,
    null,
  )
})

test('compiler logs are batched, status tails are bounded, and TeX job and event history is pruned', async (t) => {
  const f = await fixture(t)
  f.texBuilds.retainedBuilds = 3
  const run = f.runtime.runTex
  f.runtime.runTex = async (source, output, options) => {
    for (let index = 0; index < 400; index++) options.onOutput('x'.repeat(1000))
    return run(source, output, options)
  }
  let first, last
  for (let index = 0; index < 9; index++) {
    last = await f.compile()
    first ??= last
    assert.equal(last.status, 'completed')
    const activities = f.events
      .events(last.id)
      .filter((event) => event.type === 'activity')
    assert(
      activities.length <= 14,
      `log chunks were not batched: ${activities.length}`,
    )
    assert.equal(f.events.getMetadata(last.id).inputs, undefined)
  }
  await assert.rejects(async () => f.texBuilds.get('owner', first.id), {
    status: 404,
  })
  assert(
    f.events.db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE json_extract(payload,'$.kind')='tex'",
      )
      .get().count <= 5,
  )
  assert.equal(
    f.events.db
      .prepare(
        'SELECT COUNT(*) AS count FROM events WHERE job NOT IN (SELECT id FROM jobs)',
      )
      .get().count,
    0,
  )
  assert(
    f.events.db.prepare('SELECT COUNT(*) AS count FROM events').get().count <
      100,
  )
  const state = await f.texBuilds.state('owner', f.project.id)
  assert.equal(state.build.log.length, 64000)
  assert.equal(state.lastSuccessful.log, '')
})

test('failed TeX worker cleanup remains retryable and protects source captures and project lifecycle', async (t) => {
  const f = await fixture(t)
  const cleanupError = Object.assign(new Error('fixture cleanup failed'), {
    workerCleanup: true,
  })
  f.runtime.runTex = async () => {
    throw cleanupError
  }
  const job = await f.start()
  await assert.rejects(
    f.texBuilds.wait('owner', job.id),
    /fixture cleanup failed/,
  )
  assert.equal(f.texBuilds.get('owner', job.id).cleanupFailed, true)
  assert.equal(
    (await f.texBuilds.state('owner', f.project.id)).activeBuild.id,
    job.id,
  )
  const source = path.join(f.dataDir, 'tex-builds', job.id, 'source')
  assert((await fs.stat(source)).isDirectory())
  await assert.rejects(f.start(), { status: 409 })
  assert.equal((await f.post('/trash', {})).status, 409)
  let attempt = 0
  f.runtime.stopProject = async (root) => {
    assert.equal(root, source)
    if (++attempt === 1) throw cleanupError
  }
  await assert.rejects(
    f.texBuilds.stop('owner', job.id),
    /fixture cleanup failed/,
  )
  assert.equal(f.texBuilds.get('owner', job.id).cleanupFailed, true)
  await f.texBuilds.stop('owner', job.id)
  assert.equal(f.texBuilds.get('owner', job.id).cleanupFailed, false)
  assert.equal(
    (await f.texBuilds.state('owner', f.project.id)).activeBuild,
    null,
  )
  await assert.rejects(fs.stat(source), { code: 'ENOENT' })
})

test('permanent chat deletion removes its candidate TeX PDFs and history and preserves project builds', async (t) => {
  const f = await fixture(t)
  const userBuild = await f.compile()
  const chat = f.chats.create('owner', f.project.id)
  const run = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
    chatId: chat.id,
    prompt: 'Write a paper',
    mode: 'search',
  })
  f.chats.appendRun(chat.id, 'owner', run)
  const snapshot = await f.workspaces.snapshot(f.project.id, 'owner', run.id)
  const candidate = await f.texBuilds.wait(
    'owner',
    (
      await f.start(undefined, {
        sourceRoot: snapshot.root,
        runId: run.id,
        origin: 'agent',
      })
    ).id,
  )
  assert.equal(candidate.status, 'completed')
  f.events.updateMetadata(run.id, { status: 'completed' })
  const receipt = f.chats.trash('owner', chat.id)
  const response = await f.post(
    `/api/trash/${receipt.trashId}/delete-forever`,
    {},
  )
  assert.equal(response.status, 200, await response.clone().text())
  await assert.rejects(
    fs.stat(path.join(f.dataDir, 'tex-builds', candidate.id)),
    { code: 'ENOENT' },
  )
  assert.throws(() => f.events.getMetadata(candidate.id), { status: 404 })
  assert.throws(() => f.events.getMetadata(run.id), { status: 404 })
  assert.deepEqual(
    (await f.texBuilds.readPdf('owner', userBuild.id)).content,
    pdf,
  )
})
