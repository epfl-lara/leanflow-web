import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'

const imageId = `sha256:${'a'.repeat(64)}`

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-tex-'))
  const dataDir = path.join(directory, 'data'),
    root = path.join(dataDir, 'sources'),
    output = path.join(dataDir, 'output'),
    docker = path.join(directory, 'docker'),
    unavailable = path.join(directory, 'unavailable'),
    hold = path.join(directory, 'hold'),
    inspections = path.join(directory, 'inspections'),
    lastRun = path.join(directory, 'last-run')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(output)
  await fs.mkdir(path.join(dataDir, 'runtime'))
  await fs.writeFile(
    docker,
    `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'image') {
  fs.appendFileSync(${JSON.stringify(inspections)}, 'inspect' + String.fromCharCode(10))
  if (fs.existsSync(${JSON.stringify(unavailable)})) process.exit(1)
  console.log(${JSON.stringify(imageId)})
}
if (args[0] === 'run') {
  fs.writeFileSync(${JSON.stringify(lastRun)}, JSON.stringify(args))
  if (args.includes('/opt/tex-compile-worker.py')) {
    console.log('compiler output')
    console.error('DOCKER_PRIVATE_PATH_SHOULD_NOT_ESCAPE')
    const artifacts = {'result.json': Buffer.from('{"success":true}').toString('base64')}
    console.log('LEANFLOW_TEX_ARTIFACTS:' + args.at(-1) + ':' + JSON.stringify({artifacts}))
  } else console.log(JSON.stringify(args))
  if (fs.existsSync(${JSON.stringify(hold)})) setInterval(() => {}, 1000)
}
`,
    { mode: 0o700 },
  )
  const runtime = new Runtime({ dataDir, docker, maxConcurrent: 1 })
  runtime.ready = true
  runtime.imageId = 'fixture-lean-image'
  t.after(async () => {
    await runtime.shutdown()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return {
    runtime,
    directory,
    dataDir,
    root,
    output,
    unavailable,
    hold,
    inspections,
    lastRun,
  }
}

test('missing TeX support caches unavailable checks and does not alter Lean readiness or successful image pins', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.unavailable, 'not installed')
  const missing = await f.runtime.texInfo()
  assert.equal(missing.available, false)
  assert.match(missing.error, /build-tex-worker/)
  await assert.rejects(
    f.runtime.runTex(f.root, f.output, { rootFile: 'main.tex' }),
    { status: 503 },
  )
  assert.equal(f.runtime.ready, true)
  assert.equal(f.runtime.imageId, 'fixture-lean-image')
  await fs.rm(f.unavailable)
  const cached = await Promise.all(
    Array.from({ length: 20 }, () => f.runtime.texInfo()),
  )
  assert(cached.every((info) => !info.available))
  assert.equal(
    (await fs.readFile(f.inspections, 'utf8')).trim().split('\n').length,
    1,
  )
  f.runtime.texUnavailable.until = Date.now() - 1
  const checks = await Promise.all([f.runtime.texInfo(), f.runtime.texInfo()])
  assert.equal(checks[0].imageId, imageId)
  assert.deepEqual(checks[0].engines, ['pdflatex'])
  await fs.writeFile(f.unavailable, 'tag no longer exists')
  assert.equal((await f.runtime.texInfo()).imageId, imageId)
  assert.equal(
    (await fs.readFile(f.inspections, 'utf8')).trim().split('\n').length,
    2,
  )
  assert.equal((await f.runtime.run(f.root, ['true'])).code, 0)
})

test('TeX workers expose only readonly sources, isolated temporary files, and fixed output storage', async (t) => {
  const f = await fixture(t)
  const visible = []
  let spawned = false
  const result = await f.runtime.runTex(f.root, f.output, {
    rootFile: 'paper/main draft.tex',
    onSpawn: () => {
      spawned = true
    },
    onOutput: (text) => visible.push(text),
  })
  const args = JSON.parse(await fs.readFile(f.lastRun, 'utf8'))
  const mounts = args.flatMap((value, index) =>
    value === '--mount' ? [args[index + 1]] : [],
  )
  assert.deepEqual(mounts, [`type=bind,src=${f.root},dst=/workspace,readonly`])
  assert.equal(args[args.indexOf('--network') + 1], 'none')
  assert.equal(args[args.indexOf('--log-driver') + 1], 'none')
  assert.equal(args[args.indexOf('--ulimit') + 1], 'fsize=33554432:33554432')
  assert(args.includes('--read-only'))
  assert(args.includes('no-new-privileges'))
  assert(args.includes('/tmp:rw,nosuid,nodev,noexec,size=512m'))
  assert(
    args.some((value) =>
      value.startsWith('/output:rw,nosuid,nodev,noexec,size=32m,'),
    ),
  )
  assert(args.includes(imageId))
  assert.equal(args.at(-2), 'paper/main draft.tex')
  assert.equal(args.filter((value) => value === '--env').length, 1)
  assert.equal(args[args.indexOf('--env') + 1], 'HOME=/tmp/home')
  assert.equal(result.code, 0)
  assert.equal(spawned, true)
  assert.match(visible.join(''), /compiler output/)
  assert(!visible.join('').includes('LEANFLOW_TEX_ARTIFACTS'))
  assert(!visible.join('').includes('DOCKER_PRIVATE_PATH'))
  assert(!result.stdout.includes('LEANFLOW_TEX_ARTIFACTS'))
  assert.equal(result.stderr, '')
  assert.equal(
    await fs.readFile(path.join(f.output, 'result.json'), 'utf8'),
    '{"success":true}',
  )
})

test('TeX rejects unsupported engines, path injection, overlapping and nonempty output roots', async (t) => {
  const f = await fixture(t)
  for (const options of [
    { rootFile: 'main.tex', engine: 'xelatex' },
    { rootFile: '../main.tex' },
    { rootFile: 'main\\bad.tex' },
    { rootFile: '/main.tex' },
    { rootFile: 'main.tex\n' },
  ])
    await assert.rejects(f.runtime.runTex(f.root, f.output, options), {
      status: 400,
    })
  for (const outputRoot of [f.root, f.dataDir])
    await assert.rejects(
      f.runtime.runTex(f.root, outputRoot, { rootFile: 'main.tex' }),
      /separate source/,
    )
  await fs.mkdir(path.join(f.root, 'nested'))
  await assert.rejects(
    f.runtime.runTex(f.root, path.join(f.root, 'nested'), {
      rootFile: 'main.tex',
    }),
    /separate source/,
  )
  await fs.writeFile(path.join(f.output, 'document.pdf'), 'old output')
  await assert.rejects(
    f.runtime.runTex(f.root, f.output, { rootFile: 'main.tex' }),
    /empty output/,
  )
  await fs.rm(path.join(f.output, 'document.pdf'))
  await fs.symlink(f.output, path.join(f.dataDir, 'alias'))
  await assert.rejects(
    f.runtime.runTex(f.root, path.join(f.dataDir, 'alias'), {
      rootFile: 'main.tex',
    }),
    /separate source/,
  )
  assert.equal(f.runtime.children.size, 0)
})

test('queued TeX work shares Lean capacity and cancellation does not interrupt the active Lean worker', async (t) => {
  const f = await fixture(t),
    running = deferred(),
    controller = new AbortController()
  await f.runtime.texInfo()
  await fs.writeFile(f.hold, 'keep worker active')
  const lean = f.runtime.run(f.root, ['lean-check'], {
    onOutput: running.resolve,
  })
  await running.promise
  const tex = f.runtime.runTex(f.root, f.output, {
    rootFile: 'main.tex',
    signal: controller.signal,
  })
  // Image lookup is asynchronous even after the immutable ID has been cached.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.runtime.queue.length, 1)
  controller.abort(new Error('Build superseded by a newer revision.'))
  await assert.rejects(tex, /superseded/)
  assert.equal(f.runtime.queue.length, 0)
  assert.equal(f.runtime.children.size, 1)
  assert.equal([...f.runtime.children][0].cancelled, undefined)
  await f.runtime.stopProject(f.root)
  assert.equal((await lean).cancelled, true)
})

test('stopping active TeX work releases its slot only through shared container cleanup', async (t) => {
  const f = await fixture(t),
    running = deferred(),
    controller = new AbortController()
  await fs.writeFile(f.hold, 'keep compiler active')
  const tex = f.runtime.runTex(f.root, f.output, {
    rootFile: 'main.tex',
    signal: controller.signal,
    onOutput: running.resolve,
  })
  await running.promise
  await fs.rm(f.hold)
  const lean = f.runtime.run(f.root, ['lean-after-tex'])
  assert.equal(f.runtime.queue.length, 1)
  controller.abort()
  assert.equal((await tex).cancelled, true)
  assert.equal((await lean).code, 0)
  assert.equal(f.runtime.children.size, 0)
})

test('a TeX timeout uses the shared process-tree stop and reports timedOut', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.hold, 'compiler loop')
  const result = await f.runtime.runTex(f.root, f.output, {
    rootFile: 'main.tex',
    timeoutMs: 100,
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.cancelled, true)
  assert.equal(f.runtime.children.size, 0)
})

test(
  'real TeX compiler builds multi-file projects while ignoring project recipes and disabling shell escape',
  { skip: process.env.STUDIO_TEX_INTEGRATION !== '1' },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'leanflow-tex-integration-'),
    )
    const runtime = new Runtime({
      dataDir: directory,
      scope: 'tex-test',
      cpus: 1,
      memory: '1g',
    })
    t.after(async () => {
      await runtime.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    })
    const source = path.join(directory, 'source'),
      output = path.join(directory, 'output')
    await fs.mkdir(path.join(source, 'chapters'), { recursive: true })
    await fs.mkdir(output)
    const main = String.raw`\documentclass{article}
\usepackage{amsmath,tikz,graphicx,makeidx}
\makeindex
\begin{document}
\section{Isolated project}
\include{chapters/intro}
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}
\includegraphics[width=1cm]{assets/red.png}
\immediate\write18{touch /output/shell-ran}
\bibliographystyle{plain}\bibliography{references}
\printindex
\end{document}
`
    const mainPath = path.join(source, 'main;echo trap.tex')
    await fs.writeFile(mainPath, main)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
      'base64',
    )
    await fs.mkdir(path.join(source, 'assets'))
    await fs.writeFile(path.join(source, 'assets/red.png'), png)
    await fs.writeFile(
      path.join(source, 'chapters/intro.tex'),
      String.raw`A real citation~\cite{knuth}. Mathematics: $\sum_i i$.\index{LeanFlow}`,
    )
    await fs.writeFile(
      path.join(source, 'references.bib'),
      '@book{knuth,author={Donald Knuth},title={The TeXbook},year={1984},publisher={Addison-Wesley}}',
    )
    await fs.writeFile(
      path.join(source, '.latexmkrc'),
      'system("touch /output/recipe-ran"); die("Project recipe executed");',
    )
    await fs.writeFile(
      path.join(source, 'texmf.cnf'),
      'shell_escape = t\nopenout_any = a\n',
    )
    const build = await runtime.runTex(source, output, {
      rootFile: 'main;echo trap.tex',
    })
    assert.equal(build.code, 0, build.stdout + build.stderr)
    assert.deepEqual((await fs.readdir(output)).sort(), [
      'document.pdf',
      'document.txt',
      'result.json',
    ])
    const result = JSON.parse(
      await fs.readFile(path.join(output, 'result.json'), 'utf8'),
    )
    assert.equal(result.success, true)
    assert.equal(result.engine, 'pdflatex')
    assert.equal(result.rootFile, 'main;echo trap.tex')
    assert.match(
      await fs.readFile(path.join(output, 'document.txt'), 'utf8'),
      /Knuth/,
    )
    assert.equal(await fs.readFile(mainPath, 'utf8'), main)
    assert(result.pageCount >= 1)
    assert.equal(result.textAvailable, true)
    assert.match(
      await fs.readFile(path.join(output, 'document.txt'), 'utf8'),
      /Index/,
    )
    assert(
      !result.diagnostics.some((entry) =>
        /undefined|Rerun to get cross-references/i.test(entry.message),
      ),
      JSON.stringify(result.diagnostics),
    )

    const nestedOutput = path.join(directory, 'nested-output')
    await fs.mkdir(nestedOutput)
    await fs.mkdir(path.join(source, 'nested/sections'), { recursive: true })
    await fs.mkdir(path.join(source, 'nested/assets'))
    await fs.writeFile(path.join(source, 'nested/assets/red.png'), png)
    await fs.writeFile(
      path.join(source, 'nested/sections/descendant.tex'),
      'Nested source chapter.',
    )
    await fs.writeFile(
      path.join(source, 'nested/main.tex'),
      String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}\input{sections/descendant}\includegraphics{assets/red.png}\end{document}`,
    )
    const nested = await runtime.runTex(source, nestedOutput, {
      rootFile: 'nested/main.tex',
    })
    assert.equal(nested.code, 0, nested.stdout + nested.stderr)
    assert.match(
      await fs.readFile(path.join(nestedOutput, 'document.txt'), 'utf8'),
      /Nested source chapter/,
    )

    const longPath =
      'chapters/2024-evaluation/very-long-directory-name-with-extra-detail/experimental-results-with-a-very-long-filename.tex'
    await fs.mkdir(path.dirname(path.join(source, longPath)), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(source, longPath),
      '\n'.repeat(141) + '\\unknownLongPathCommand\n',
    )
    await fs.writeFile(
      path.join(source, 'long-path.tex'),
      String.raw`\documentclass{article}
\begin{document}\input{` +
        longPath +
        String.raw`}\end{document}`,
    )
    const longOutput = path.join(directory, 'long-output')
    await fs.mkdir(longOutput)
    const long = await runtime.runTex(source, longOutput, {
      rootFile: 'long-path.tex',
    })
    assert.notEqual(long.code, 0)
    const longReport = JSON.parse(
      await fs.readFile(path.join(longOutput, 'result.json'), 'utf8'),
    )
    assert(
      longReport.diagnostics.some(
        (entry) => entry.file === longPath && entry.line === 142,
      ),
      JSON.stringify(longReport.diagnostics),
    )

    for (const [filename, content] of [
      [
        'diagram.tikz',
        String.raw`\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}`,
      ],
      ['drawing.pgf', 'PGF source fragment.'],
      ['extra.ltx', 'LaTeX source fragment.'],
      [
        'prepared.bbl',
        String.raw`\begin{thebibliography}{1}\bibitem{prepared}Prepared bibliography.\end{thebibliography}`,
      ],
    ])
      await fs.writeFile(path.join(source, filename), content)
    await fs.writeFile(
      path.join(source, 'extra-inputs.tex'),
      String.raw`\documentclass{article}
\usepackage{tikz}\begin{document}\input{diagram.tikz}\input{drawing.pgf}\input{extra.ltx}\input{prepared.bbl}\end{document}`,
    )
    const extraOutput = path.join(directory, 'extra-output')
    await fs.mkdir(extraOutput)
    const extra = await runtime.runTex(source, extraOutput, {
      rootFile: 'extra-inputs.tex',
    })
    assert.equal(extra.code, 0, extra.stdout + extra.stderr)
    assert.match(
      await fs.readFile(path.join(extraOutput, 'document.txt'), 'utf8'),
      /Prepared bibliography/,
    )

    await fs.writeFile(
      path.join(source, 'biber.tex'),
      String.raw`\documentclass{article}
\newwrite\bcffile
\begin{document}Biber fixture.
\immediate\openout\bcffile=\jobname.bcf
\immediate\write\bcffile{<?xml version="1.0" encoding="UTF-8"?>}
\immediate\write\bcffile{<bcf:controlfile version="3.10" bltxversion="3.20" xmlns:bcf="https://sourceforge.net/projects/biblatex">}
\immediate\write\bcffile{<bcf:bibdata section="0"><bcf:datasource type="file" datatype="bibtex">references.bib</bcf:datasource></bcf:bibdata>}
\immediate\write\bcffile{<bcf:section number="0"><bcf:citekey order="1" intorder="1">knuth</bcf:citekey></bcf:section>}
\immediate\write\bcffile{</bcf:controlfile>}
\immediate\closeout\bcffile
\makeatletter\@input{\jobname.bbl}\makeatother
\end{document}`,
    )
    const biberOutput = path.join(directory, 'biber-output')
    await fs.mkdir(biberOutput)
    const biber = await runtime.runTex(source, biberOutput, {
      rootFile: 'biber.tex',
    })
    assert.notEqual(biber.code, 0)
    const biberReport = JSON.parse(
      await fs.readFile(path.join(biberOutput, 'result.json'), 'utf8'),
    )
    assert(
      biberReport.diagnostics.some((entry) =>
        /Biber is unavailable.*Use BibTeX/.test(entry.message),
      ),
      JSON.stringify(biberReport.diagnostics),
    )

    const parentOutput = path.join(directory, 'parent-output')
    await fs.mkdir(parentOutput)
    await fs.writeFile(
      path.join(source, 'nested/parent.tex'),
      String.raw`\documentclass{article}
\begin{document}\input{../chapters/intro}\end{document}`,
    )
    const parent = await runtime.runTex(source, parentOutput, {
      rootFile: 'nested/parent.tex',
    })
    assert.notEqual(parent.code, 0)
    const parentResult = JSON.parse(
      await fs.readFile(path.join(parentOutput, 'result.json'), 'utf8'),
    )
    assert(
      parentResult.diagnostics.some((entry) =>
        /common project root/.test(entry.message),
      ),
      JSON.stringify(parentResult),
    )

    const brokenOutput = path.join(directory, 'broken-output')
    await fs.mkdir(brokenOutput)
    await fs.writeFile(
      path.join(source, 'chapters/intro.tex'),
      'First line.\n\\unknownLeanFlowCommand\n',
    )
    const broken = await runtime.runTex(source, brokenOutput, {
      rootFile: 'main;echo trap.tex',
    })
    assert.notEqual(broken.code, 0)
    const diagnostic = JSON.parse(
      await fs.readFile(path.join(brokenOutput, 'result.json'), 'utf8'),
    )
    assert(
      diagnostic.diagnostics.some(
        (entry) => entry.file === 'chapters/intro.tex' && entry.line === 2,
      ),
    )

    const escapeOutput = path.join(directory, 'escape-output')
    await fs.mkdir(escapeOutput)
    await fs.writeFile(
      path.join(source, 'chapters/intro.tex'),
      String.raw`\input{/etc/passwd}`,
    )
    const escape = await runtime.runTex(source, escapeOutput, {
      rootFile: 'main;echo trap.tex',
    })
    assert.notEqual(escape.code, 0)
    assert(!escape.stdout.includes('root:x:'))

    for (const [name, prefix] of [
      ['plain', ''],
      ['bom', '\ufeff'],
    ]) {
      const directiveOutput = path.join(directory, `directive-${name}`)
      await fs.mkdir(directiveOutput)
      await fs.writeFile(mainPath, prefix + '% !TeX program = xelatex\n' + main)
      const directive = await runtime.runTex(source, directiveOutput, {
        rootFile: 'main;echo trap.tex',
      })
      assert.notEqual(directive.code, 0)
      assert.match(directive.stdout, /requests xelatex.*supports pdfLaTeX only/)
    }

    const noisyOutput = path.join(directory, 'noisy-output')
    await fs.mkdir(noisyOutput)
    await fs.writeFile(mainPath, main)
    await fs.writeFile(
      path.join(source, 'chapters/intro.tex'),
      String.raw`\newcount\noisycount
\loop\typeout{Repeated fixture compiler output to fill the bounded log before a later source error.}
\advance\noisycount by 1
\ifnum\noisycount<4000\repeat
\MissingFixtureCommand
`,
    )
    const noisy = await runtime.runTex(source, noisyOutput, {
      rootFile: 'main;echo trap.tex',
    })
    assert.notEqual(noisy.code, 0)
    const noisyReport = JSON.parse(
      await fs.readFile(path.join(noisyOutput, 'result.json'), 'utf8'),
    )
    assert.equal(noisyReport.logTruncated, true)
    assert(
      noisyReport.diagnostics.some(
        (entry) =>
          entry.file === 'chapters/intro.tex' &&
          entry.line === 5 &&
          /Undefined control sequence/.test(entry.message),
      ),
    )
    assert(noisy.stdout.length < 300000)

    const symlinkOutput = path.join(directory, 'symlink-output')
    await fs.mkdir(symlinkOutput)
    await fs.symlink('/etc/passwd', path.join(source, 'linked.tex'))
    const symlink = await runtime.runTex(source, symlinkOutput, {
      rootFile: 'main;echo trap.tex',
    })
    assert.notEqual(symlink.code, 0)
    assert.match(symlink.stdout, /symbolic links/)
  },
)
