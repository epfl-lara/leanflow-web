import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  checkEditorImports,
  projectImportRequirements,
} from '../editor-imports.mjs'

const toolchain = 'leanprover/lean4:v4.34.1\n'

async function directory(t, prefix = 'leanflow-editor-imports-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function project(t) {
  const base = await directory(t)
  const root = path.join(base, 'project')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'lean-toolchain'), toolchain)
  return { base, root }
}

const fakeLean = String.raw`#!/usr/bin/env python3
import json, os, pathlib, stat, sys

if sys.argv[1:3] == ['--deps-json', '--stdin']:
    paths = sys.stdin.read().splitlines()
    print(json.dumps({'imports': [{'errors': [], 'result': {'imports': [{'module': name} for name in ['Init', 'Optional.Theorem', 'Optional.Theorem']]}} for _ in paths]}))
    sys.exit(0)

if sys.argv[1:2] != ['--deps']:
    print('fixture Lean only supports --deps', file=sys.stderr)
    sys.exit(2)
if os.environ.get('FIXTURE_COMPILER_FAILURE'):
    print('error: fixture compiler unavailable', file=sys.stderr)
    sys.exit(1)

file = pathlib.Path(sys.argv[2])
if not stat.S_ISREG(file.stat().st_mode):
    print('fixture Lean only supports regular files', file=sys.stderr)
    sys.exit(1)
try:
    source = file.read_text(encoding='utf-8')
except OSError as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)

imports = []
for line in source.splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith('--'):
        continue
    if stripped.startswith('import '):
        imports.append(stripped.split(None, 1)[1].strip())
        continue
    break

for module in imports:
    if os.environ.get('FIXTURE_PRINT_MISSING'):
        print(str(pathlib.Path('/workspace/.lake/build/lib/lean') / pathlib.Path(*module.split('.')).with_suffix('.olean')))
        continue
    found = None
    for prefix in os.environ.get('LEAN_PATH', '').split(os.pathsep):
        if not prefix:
            continue
        candidate = pathlib.Path(prefix).joinpath(*module.split('.')).with_suffix('.olean')
        if candidate.is_file():
            found = candidate
            break
    if found is None:
        expected = pathlib.Path('/workspace/.lake/build/lib/lean') / pathlib.Path(*module.split('.')).with_suffix('.olean')
        print("error: object file '" + str(expected) + "' of module " + module + " does not exist", file=sys.stderr)
        if os.environ.get('FIXTURE_SEARCH_PATH_NOISE'):
            for _ in range(6):
                print('/opt/lean-toolchains/fixture/lib/lean/Init.olean')
        sys.exit(1)
    print(found)
sys.exit(0)
`

async function fakeToolchain(t) {
  const bin = await directory(t, 'leanflow-fake-lean-')
  const executable = path.join(bin, 'lean')
  await fs.writeFile(executable, fakeLean, { mode: 0o755 })
  return bin
}

function runPython(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: code ?? (signal ? 130 : 1), stdout, stderr })
    })
  })
}

// Run the trusted worker locally against a fixture workspace, emulating the
// Lake-provided environment while keeping the production script unchanged.
function workerRuntime(root, leanDirectory, env = {}) {
  const calls = []
  return {
    calls,
    async run(runRoot, args, options = {}) {
      calls.push({ root: runRoot, args, options })
      const index = args.indexOf('python3')
      assert.notEqual(index, -1)
      assert.deepEqual(args.slice(index + 1, index + 3), ['-I', '-c'])
      const script = args[index + 3]
      const config = JSON.parse(args[index + 4])
      config.workspace = root
      return runPython(['-I', '-c', script, JSON.stringify(config)], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${leanDirectory}${path.delimiter}${process.env.PATH}`,
          LEAN_PATH: path.join(root, '.lake/build/lib/lean'),
          LEAN_SYSROOT: '',
          ...env,
        },
      })
    },
  }
}

async function compiledModule(root, module) {
  const file = path.join(
    root,
    '.lake/build/lib/lean',
    `${module.replaceAll('.', '/')}.olean`,
  )
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'fixture module')
}

test('checks editor imports in one pinned Lake worker and preserves runtime options', async (t) => {
  const { root } = await project(t)
  const calls = []
  const onOutput = () => {}
  const controller = new AbortController()
  const runtime = {
    async run(runRoot, args, options) {
      calls.push({ root: runRoot, args, options })
      return {
        code: 0,
        stdout: '{"ready":true,"message":"Project imports are ready."}\n',
        stderr: '',
        truncated: false,
      }
    },
  }
  assert.deepEqual(
    await checkEditorImports(runtime, root, {
      signal: controller.signal,
      timeoutMs: 90_000,
      onOutput,
    }),
    { ready: true, message: 'Project imports are ready.' },
  )
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.root, root)
  assert.deepEqual(call.args.slice(0, 6), [
    'lake',
    '--keep-toolchain',
    'env',
    'python3',
    '-I',
    '-c',
  ])
  assert.match(call.args[6], /--deps/)
  const config = JSON.parse(call.args[7])
  assert.equal(config.workspace, '/workspace')
  assert(config.maxFiles > 0)
  assert(config.maxOutputBytes > 0)
  assert(config.deadlineMs > 0 && config.deadlineMs < 90_000)
  assert.equal(call.options.signal, controller.signal)
  assert.equal(call.options.onOutput, onOutput)
  assert.equal(call.options.timeoutMs, 90_000)
  assert.equal(call.options.network, 'none')
  assert.equal(call.options.readOnlyWorkspace, true)
  assert.equal(call.options.writeLakeCache, true)
})

test('a missing local compiled import is unavailable until its module is built', async (t) => {
  const { root } = await project(t)
  const lean = await fakeToolchain(t)
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'import Helper\n\ntheorem main_ready : True := by\n  sorry\n',
  )
  await fs.writeFile(
    path.join(root, 'Helper.lean'),
    'theorem helper_ready : True := by\n  sorry\n',
  )
  const runtime = workerRuntime(root, lean)
  const missing = await checkEditorImports(runtime, root)
  assert.equal(missing.ready, false)
  assert.match(missing.message, /Helper/)
  assert.match(missing.message, /compiled module/)
  assert.match(missing.message, /Rebuild/)
  assert.equal(runtime.calls.length, 1)
  await compiledModule(root, 'Helper')
  assert.deepEqual(await checkEditorImports(runtime, root), {
    ready: true,
    message: 'Project imports are ready (2 Lean files checked).',
  })
})

test('an imported module with an unfinished sorry proof is ready when its olean resolves', async (t) => {
  const { root } = await project(t)
  const lean = await fakeToolchain(t)
  await fs.writeFile(path.join(root, 'Main.lean'), 'import Helper\n')
  await fs.writeFile(
    path.join(root, 'Helper.lean'),
    'theorem unfinished : False := by\n  sorry\n',
  )
  await compiledModule(root, 'Helper')
  const result = await checkEditorImports(workerRuntime(root, lean), root)
  assert.equal(result.ready, true)
  assert.match(result.message, /ready/)
  assert.match(result.message, /2 Lean files checked/)
})

test('missing import errors retain the module name when Lean prints trailing resolved paths', async (t) => {
  const { root } = await project(t)
  const lean = await fakeToolchain(t)
  await fs.writeFile(path.join(root, 'Notes.lean'), 'import Helper.Optional\n')
  const result = await checkEditorImports(
    workerRuntime(root, lean, { FIXTURE_SEARCH_PATH_NOISE: '1' }),
    root,
  )
  assert.equal(result.ready, false)
  assert.match(result.message, /Notes\.lean imports Helper\.Optional/)
  assert.match(result.message, /Rebuild/)
  assert.doesNotMatch(result.message, /\/opt\/lean-toolchains/)
})

test('a project without local Lean sources needs no import check', async (t) => {
  const { root } = await project(t)
  const lean = await fakeToolchain(t)
  await fs.writeFile(path.join(root, 'lakefile.lean'), 'import Missing\n')
  await fs.mkdir(path.join(root, '.lake/build'), { recursive: true })
  await fs.writeFile(
    path.join(root, '.lake/build/Generated.lean'),
    'import Missing\n',
  )
  const result = await checkEditorImports(
    workerRuntime(root, lean, { FIXTURE_COMPILER_FAILURE: '1' }),
    root,
  )
  assert.equal(result.ready, true)
  assert.match(result.message, /No local Lean source files/)
})

test('compiler --deps failures are reported as unavailable imports instead of thrown', async (t) => {
  const { root } = await project(t)
  const lean = await fakeToolchain(t)
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'example : True := by\n  trivial\n',
  )
  const result = await checkEditorImports(
    workerRuntime(root, lean, { FIXTURE_COMPILER_FAILURE: '1' }),
    root,
  )
  assert.equal(result.ready, false)
  assert.match(result.message, /imports are not ready/)
  assert.match(result.message, /Main\.lean/)
  assert.match(result.message, /Refresh setup|Rebuild/)
})

test('a successful deps report that points to a missing olean is not ready', async (t) => {
  const { root } = await project(t)
  const lean = await fakeToolchain(t)
  await fs.writeFile(path.join(root, 'Main.lean'), 'import Missing\n')
  const result = await checkEditorImports(
    workerRuntime(root, lean, { FIXTURE_PRINT_MISSING: '1' }),
    root,
  )
  assert.equal(result.ready, false)
  assert.match(result.message, /Missing/)
  assert.match(result.message, /compiled module/)
})

test('malformed or failed worker results are never reported as success', async (t) => {
  const { root } = await project(t)
  for (const [result, message] of [
    [{ code: 0, stdout: 'not json' }, /usable result/],
    [
      {
        code: 0,
        stdout: '{"ready":"yes","message":"Project imports are ready."}',
      },
      /usable result/,
    ],
    [{ code: 0, stdout: '{"ready":true}' }, /usable result/],
    [{ code: 0, stdout: '{"ready":true,"message":""}' }, /usable result/],
    [{ code: 0, stdout: '' }, /usable result/],
    [
      {
        code: 1,
        stdout: '{"ready":true,"message":"Project imports are ready."}',
      },
      /could not finish/,
    ],
    [
      {
        code: 0,
        stdout: '{"ready":true,"message":"Project imports are ready."}',
        truncated: true,
      },
      /too much output/,
    ],
  ]) {
    const checked = await checkEditorImports({ run: async () => result }, root)
    assert.equal(checked.ready, false)
    assert.match(checked.message, message)
  }
})

test('a worker launch failure is returned as an actionable result', async (t) => {
  const { root } = await project(t)
  const result = await checkEditorImports(
    {
      async run() {
        throw new Error('worker failed to start')
      },
    },
    root,
  )
  assert.equal(result.ready, false)
  assert.match(result.message, /could not start/)
  assert.match(result.message, /Refresh setup/)
})

test('cancellation is thrown and stops the worker', async (t) => {
  const { root } = await project(t)
  let calls = 0
  const preAborted = new AbortController()
  const stopped = new Error('Stop the import check')
  preAborted.abort(stopped)
  await assert.rejects(
    () =>
      checkEditorImports(
        {
          async run() {
            calls++
            return { code: 0, stdout: '' }
          },
        },
        root,
        { signal: preAborted.signal },
      ),
    (error) => error === stopped,
  )
  assert.equal(calls, 0)

  const controller = new AbortController()
  let started
  const running = new Promise((resolve) => {
    started = resolve
  })
  const pending = checkEditorImports(
    {
      run: (_root, _args, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          )
          started()
        }),
    },
    root,
    { signal: controller.signal },
  )
  await running
  controller.abort(stopped)
  await assert.rejects(
    () => pending,
    (error) => error === stopped,
  )

  await assert.rejects(
    () =>
      checkEditorImports(
        {
          async run() {
            return { code: 130, stdout: '', stderr: '', cancelled: true }
          },
        },
        root,
      ),
    /cancelled/,
  )
})

test('symlinked, hidden, excluded, and nonregular Lean paths are not inspected', async (t) => {
  const { base, root } = await project(t)
  const lean = await fakeToolchain(t)
  await fs.writeFile(path.join(root, 'Main.lean'), 'import Helper\n')
  await fs.writeFile(
    path.join(root, 'Helper.lean'),
    'theorem helper_ready : True := by\n  sorry\n',
  )
  await compiledModule(root, 'Helper')
  const outside = path.join(base, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'Bad.lean'), 'import Missing\n')
  await fs.symlink(outside, path.join(root, 'LinkedDirectory'), 'dir')
  await fs.symlink(
    path.join(outside, 'Bad.lean'),
    path.join(root, 'LinkedFile.lean'),
    'file',
  )
  const fifo = path.join(root, 'Pipe.lean')
  const madeFifo = spawnSync('mkfifo', [fifo]).status === 0
  const result = await checkEditorImports(workerRuntime(root, lean), root)
  assert.equal(result.ready, true, result.message)
  assert.match(result.message, /2 Lean files checked/)
  if (!madeFifo) return
  // The FIFO was skipped rather than opened or traversed.
  assert.equal((await fs.lstat(fifo)).isFIFO(), true)
})

test('dependency import requirements are collected before Lake or compiled modules are available', async (t) => {
  const { root } = await project(t)
  const lean = await fakeToolchain(t)
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'import Optional.Theorem\nexample : False := by sorry\n',
  )
  const runtime = workerRuntime(root, lean)
  assert.deepEqual(await projectImportRequirements(runtime, root), [
    'Init',
    'Optional.Theorem',
  ])
  assert.equal(runtime.calls[0].args[0], 'python3')
  assert.equal(runtime.calls[0].options.network, 'none')
  assert.equal(runtime.calls[0].options.cleanHome, true)
  assert.equal(runtime.calls[0].options.readOnlyWorkspace, true)
})

test('failed or malformed dependency import requirements cannot certify cache coverage', async (t) => {
  const { root } = await project(t)
  for (const result of [
    { code: 1, stdout: '' },
    { code: 0, stdout: '{"ready":false,"modules":[]}' },
    { code: 0, stdout: '{"ready":true,"modules":[false]}' },
    { code: 0, stdout: 'unstructured compiler output' },
    { code: 0, stdout: '{"ready":true,"modules":[]}', truncated: true },
  ])
    await assert.rejects(
      projectImportRequirements({ run: async () => result }, root),
      /Could not inspect/,
    )
})
