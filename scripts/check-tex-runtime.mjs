#!/usr/bin/env node
// Real Docker compilation and application artifact lifecycle, without provider calls.
// Uses its own database and sources; STUDIO_DATA_DIR is deliberately not used.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'
import { EventStore } from '../server/events.mjs'
import { TexBuildManager } from '../server/tex-builds.mjs'

assert.equal(
  process.platform,
  'linux',
  'Run this Docker/compiler check on Linux.',
)
const reportDir = path.resolve('.runtime/tex-runtime-check')
await fs.mkdir(reportDir, { recursive: true, mode: 0o700 })
const dataDir = await fs.realpath(
  await fs.mkdtemp(path.join(reportDir, 'run-')),
)
await fs.mkdir(path.join(dataDir, 'runtime'), { mode: 0o700 })
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  maxConcurrent: 1,
  maxQueue: 2,
  cpus: 1,
  memory: '1g',
})
const owner = 'tex-runtime-check'
const report = { providerCalls: 0, checks: [] }
let workspaces, events, builds, shutdown
const shutDown = () =>
  (shutdown ||= (async () => {
    await builds?.shutdown()
    await runtime.shutdown()
  })())
const stop = () => {
  process.exitCode = 130
  void shutDown().catch(() => {})
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

async function until(predicate, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    assert(!runtime.stopping && !process.exitCode, 'Verification stopped')
    assert(Date.now() < deadline, message)
    await delay(25)
  }
}

async function fixtureProject(name) {
  const id = randomUUID()
  const project = {
    id,
    owner,
    name,
    status: 'ready',
    root: path.join(workspaces.projectsDir, id),
  }
  await fs.mkdir(project.root, { mode: 0o700 })
  // Register only this fixture. TeX capture does not need a Lean toolchain;
  // bypassing Lean preparation keeps this compiler gate offline and focused.
  workspaces.db
    .prepare('INSERT INTO projects(id,owner,data) VALUES(?,?,?)')
    .run(id, owner, JSON.stringify(project))
  return project
}

const main = String.raw`\documentclass{article}
\usepackage{amsmath,local}
\begin{document}
\section{LeanFlow compiler check}
\include{chapters/intro}
\immediate\write18{touch shell-marker.txt}
\IfFileExists{shell-marker.txt}{\errmessage{Shell escape was enabled}}{}
\bibliographystyle{plain}\bibliography{references}
\end{document}
`
const chapter = String.raw`\fixtureword{}: a multi-file document with $a+b=b+a$.
A real citation~\cite{knuth}.
`
const loop = String.raw`\documentclass{article}
\begin{document}
\newcount\fixturecount
\loop\advance\fixturecount by 0\iftrue\repeat
\end{document}
`
const rootFile = 'main;echo trap.tex'
const compile = async (project, selectedRoot = rootFile) =>
  builds.wait(
    owner,
    (await builds.start(owner, project.id, { rootFile: selectedRoot })).id,
  )

try {
  const info = await runtime.texInfo()
  assert.equal(info.available, true, info.error)
  report.imageId = info.imageId
  workspaces = await new WorkspaceStore({ dataDir, runtime }).init()
  events = new EventStore(dataDir)
  builds = await new TexBuildManager({
    dataDir,
    runtime,
    workspaces,
    events,
  }).init()
  const project = await fixtureProject('Compiler lifecycle')
  const root = project.root
  await fs.mkdir(path.join(root, 'chapters'))
  await fs.writeFile(path.join(root, rootFile), main)
  await fs.writeFile(path.join(root, 'chapters/intro.tex'), chapter)
  await fs.writeFile(
    path.join(root, 'local.sty'),
    String.raw`\ProvidesPackage{local}\newcommand{\fixtureword}{Fixture}`,
  )
  await fs.writeFile(
    path.join(root, 'references.bib'),
    '@book{knuth,author={Donald Knuth},title={The TeXbook},year={1984},publisher={Addison-Wesley}}',
  )
  await fs.writeFile(
    path.join(root, '.env'),
    'FIXTURE_SECRET=not-for-the-compiler',
  )
  await fs.writeFile(
    path.join(root, '.latexmkrc'),
    'die("Project recipes must not execute");',
  )
  await fs.writeFile(
    path.join(root, 'texmf.cnf'),
    'shell_escape=t\nopenin_any=a\n',
  )
  const success = await compile(project)
  assert.equal(success.status, 'completed', success.error || success.log)
  assert.equal(success.textAvailable, true)
  assert(success.pageCount >= 1)
  const pdf = (await builds.readPdf(owner, success.id)).content
  assert.match(pdf.subarray(0, 16).toString(), /^%PDF-/)
  const text = (await builds.readText(owner, success.id)).content
  assert.match(text, /Fixture/)
  assert.match(text, /Knuth/)
  assert.equal(await fs.readFile(path.join(root, rootFile), 'utf8'), main)
  const inputs = JSON.parse(
    await fs.readFile(
      path.join(dataDir, 'tex-builds', success.id, 'inputs.json'),
      'utf8',
    ),
  )
  assert(
    inputs.files.every(
      (file) => !['.env', '.latexmkrc', 'texmf.cnf'].includes(file.path),
    ),
  )
  assert(
    !(await fs.readdir(root)).some((file) =>
      /\.(?:aux|log|pdf|fls|fdb_latexmk)$/.test(file),
    ),
  )
  await assert.rejects(
    fs.stat(path.join(dataDir, 'tex-builds', success.id, 'source')),
    { code: 'ENOENT' },
  )
  await assert.rejects(async () => builds.get('different-owner', success.id), {
    status: 404,
  })
  report.checks.push(
    'multi-file PDF, local style, bibliography, text extraction, private snapshot and ownership',
  )

  await fs.writeFile(
    path.join(root, 'chapters/intro.tex'),
    '\\MissingFixtureCommand\n',
  )
  assert.notEqual(
    await workspaces.texSourceVersion(project.id, owner, rootFile),
    success.workspaceRevision,
  )
  const failed = await compile(project)
  assert.equal(failed.status, 'failed')
  assert(
    failed.diagnostics.some(
      (entry) =>
        entry.path === 'chapters/intro.tex' &&
        entry.line === 1 &&
        /Undefined control sequence/.test(entry.message),
    ),
    JSON.stringify(failed.diagnostics),
  )
  assert.equal(
    (await builds.state(owner, project.id, { rootFile })).lastSuccessful.id,
    success.id,
  )
  assert.deepEqual((await builds.readPdf(owner, success.id)).content, pdf)
  await assert.rejects(
    fs.stat(path.join(dataDir, 'tex-builds', failed.id, 'output')),
    { code: 'ENOENT' },
  )
  await fs.writeFile(
    path.join(root, 'chapters/intro.tex'),
    chapter + '\nRecovered document.\n',
  )
  const recovered = await compile(project)
  assert.equal(recovered.status, 'completed', recovered.error || recovered.log)
  assert.match(
    (await builds.readText(owner, recovered.id)).content,
    /Recovered document/,
  )
  report.checks.push(
    'source staleness, exact file/line diagnostics, retained successful PDF, recovery',
  )

  for (const forbidden of ['/etc/passwd', '../outside.tex']) {
    await fs.writeFile(
      path.join(root, rootFile),
      `\\documentclass{article}\n\\begin{document}\\input{${forbidden}}\\end{document}\n`,
    )
    const rejected = await compile(project)
    assert.equal(
      rejected.status,
      'failed',
      `Unsafe input accepted: ${forbidden}`,
    )
    assert(rejected.diagnostics.some((entry) => entry.severity === 'error'))
  }
  await assert.rejects(
    builds.start(owner, project.id, { rootFile: '../outside.tex' }),
    { status: 400 },
  )
  report.checks.push(
    'shell escape, project recipes, absolute/parent input and traversal containment',
  )

  await fs.writeFile(path.join(root, rootFile), loop)
  const active = await builds.start(owner, project.id, { rootFile })
  await until(
    () =>
      builds.get(owner, active.id).status === 'running' &&
      /pdfTeX|Run number 1/.test(events.getMetadata(active.id).log),
    'Compiler did not start',
  )
  const second = await fixtureProject('Queued compiler')
  await fs.writeFile(
    path.join(second.root, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}Queued PDF.\\end{document}\n',
  )
  const queued = await builds.start(owner, second.id, { rootFile: 'main.tex' })
  await until(() => runtime.queue.length === 1, 'Second compiler did not queue')
  assert.equal(builds.get(owner, queued.id).status, 'queued')
  assert.equal((await builds.stop(owner, queued.id)).status, 'cancelled')
  assert.equal(runtime.queue.length, 0)
  assert.equal(builds.get(owner, active.id).status, 'running')
  assert.equal((await builds.stop(owner, active.id)).status, 'cancelled')
  assert.equal(runtime.children.size, 0)
  assert.equal((await compile(second, 'main.tex')).status, 'completed')
  report.checks.push(
    'visible shared queue, queued cancellation, active cancellation, released capacity',
  )

  builds.timeoutMs = 1500
  const timedOut = await compile(project)
  assert.equal(timedOut.status, 'failed')
  assert.match(timedOut.error, /time limit/)
  assert.equal(runtime.children.size, 0)
  builds.timeoutMs = 120000
  await fs.writeFile(path.join(root, rootFile), main)
  assert.equal((await compile(project)).status, 'completed')
  report.checks.push('bounded compiler timeout and successful retry')
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.message
  process.exitCode = process.exitCode || 1
} finally {
  try {
    await shutDown()
    assert.equal(runtime.children.size, 0, 'Compiler cleanup did not finish')
    workspaces?.close()
    events?.db.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    report.fixtureRemoved = true
  } catch (error) {
    report.passed = false
    report.cleanupError = error.message
    report.fixtureDirectory = dataDir
    process.exitCode = process.exitCode || 1
  }
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  )
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
console.log(JSON.stringify(report))
