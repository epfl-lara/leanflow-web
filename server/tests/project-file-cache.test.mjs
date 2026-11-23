import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import path from 'node:path'
import test from 'node:test'
import { seedFileCheck, savedFileSetup } from '../project-file-cache.mjs'

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-import-copy-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'project'),
    snapshot = path.join(dir, 'snapshot')
  const lib = '.lake/build/lib/lean/Lib'
  await fs.mkdir(path.join(source, lib), { recursive: true })
  await fs.mkdir(path.join(source, '.lake/build/ir/Lib'), { recursive: true })
  await fs.mkdir(snapshot)
  await fs.writeFile(path.join(source, '.lake/build/.leanflow-cache-v1'), '')
  for (const ext of ['olean', 'olean.private', 'trace'])
    await fs.writeFile(path.join(source, lib, 'Common.' + ext), ext)
  await fs.writeFile(
    path.join(source, lib, 'Unconfigured.olean'),
    'loose module',
  )
  const runtime = {
    async run(root, args, options) {
      assert.equal(root, source)
      assert.deepEqual(args, ['lake', 'setup-file', './Main.lean'])
      assert.equal(options.readOnlyWorkspace, true)
      const importArts = {
        'Lib.Common': [['/workspace/' + lib + '/Common.olean']],
        'Mathlib.Algebra': [
          [
            '/workspace/.lake/packages/mathlib/.lake/build/lib/lean/Mathlib/Algebra.olean',
          ],
        ],
      }
      return { code: 0, stdout: JSON.stringify({ importArts }) }
    },
  }
  const seed = (maxBytes) =>
    seedFileCheck(runtime, source, snapshot, 'Main.lean', { maxBytes })
  return { lib, source, snapshot, seed, runtime }
}

test('file checks reuse the configured module and its trace in a private copy', async (t) => {
  const { lib, source, snapshot, seed } = await fixture(t)
  assert.deepEqual(await seed(1024), [''])
  const dest = path.join(snapshot, lib)
  assert.deepEqual((await fs.readdir(dest)).sort(), [
    'Common.olean',
    'Common.olean.private',
    'Common.trace',
  ])
  await fs.writeFile(path.join(dest, 'Common.olean'), 'recompiled in snapshot')
  assert.equal(
    await fs.readFile(path.join(source, lib, 'Common.olean'), 'utf8'),
    'olean',
  )
})

test('an incomplete or oversized module set leaves a cold file check and can retry', async (t) => {
  const { lib, source, snapshot, seed } = await fixture(t)
  assert.equal(await seed(3), false)
  const trace = path.join(source, lib, 'Common.trace')
  await fs.unlink(trace)
  assert.equal(await seed(1024), false)
  await assert.rejects(fs.stat(path.join(snapshot, '.lake/build')), {
    code: 'ENOENT',
  })
  await fs.writeFile(trace, 'complete')
  assert.deepEqual(await seed(1024), [''])
})

test('a check reuses both root modules and modules from a configured local path package', async (t) => {
  const { source, snapshot, lib, seed, runtime } = await fixture(t)
  await fs.writeFile(
    path.join(source, 'lake-manifest.json'),
    JSON.stringify({ packages: [{ type: 'path', dir: 'Library' }] }),
  )
  await fs.mkdir(path.join(snapshot, 'Library'))
  const nested = 'Library/.lake/build/lib/lean'
  await fs.mkdir(path.join(source, nested), { recursive: true })
  for (const ext of ['olean', 'trace'])
    await fs.writeFile(path.join(source, nested, 'Sibling.' + ext), ext)
  runtime.run = async () => ({
    code: 0,
    stdout: JSON.stringify({
      importArts: {
        'Lib.Common': [['/workspace/' + lib + '/Common.olean']],
        Sibling: [['/workspace/' + nested + '/Sibling.olean']],
        Other: [['/workspace/Unconfigured/.lake/build/lib/lean/Other.olean']],
      },
    }),
  })
  assert.deepEqual(await seed(1024), ['', 'Library'])
  assert.equal(
    await fs.readFile(path.join(snapshot, nested, 'Sibling.olean'), 'utf8'),
    'olean',
  )
  await assert.rejects(fs.stat(path.join(snapshot, 'Unconfigured')), {
    code: 'ENOENT',
  })
})

test('a stopped compiler releases the lock and the next build discards only touched module traces', async (t) => {
  const { source, snapshot, seed, lib } = await fixture(t)
  const folder = path.join(source, lib)
  await fs.writeFile(path.join(folder, 'Stable.trace'), 'completed earlier')
  const guard = fileURLToPath(
    new URL('../project-cache-worker/build_lock.py', import.meta.url),
  )
  const run = `import pathlib, runpy, sys, time
root = pathlib.Path(sys.argv[2])
with runpy.run_path(sys.argv[1])["locked_build"](root):
    if sys.argv[3] == "start":
        (root / ".lake/build/lib/lean/Lib/Common.olean").write_text("work in progress")
        print("started", flush=True)
        time.sleep(20)
`
  const args = ['-I', '-c', run, guard, source]
  const compiler = spawn('python3', [...args, 'start'])
  t.after(() => compiler.kill())
  const closed = once(compiler, 'close')
  await once(compiler.stdout, 'data')
  compiler.kill('SIGKILL')
  await closed
  assert.equal(await seed(1024), false)
  await assert.rejects(fs.stat(path.join(snapshot, '.lake/build')), {
    code: 'ENOENT',
  })
  await promisify(execFile)('python3', [...args, 'retry'])
  await assert.rejects(fs.stat(path.join(folder, 'Common.trace')), {
    code: 'ENOENT',
  })
  assert.equal(
    await fs.readFile(path.join(folder, 'Stable.trace'), 'utf8'),
    'completed earlier',
  )
})

test('overlapping editor requests share one saved-file compiler and release cancelled waiters independently', async (t) => {
  const { source } = await fixture(t)
  const finish = Promise.withResolvers()
  const started = Promise.withResolvers()
  const secondReady = Promise.withResolvers()
  let calls = 0
  const runtime = {
    async run(root, args, { signal }) {
      calls++
      started.resolve()
      await finish.promise
      signal.throwIfAborted()
      return { code: 0 }
    },
  }
  const controller = new AbortController()
  const first = savedFileSetup(
    runtime,
    source,
    'Main.lean',
    null,
    controller.signal,
  )
  const stopped = assert.rejects(first, /closed editor/)
  await started.promise
  const secondSignal = new AbortController().signal
  const original = secondSignal.addEventListener.bind(secondSignal)
  t.mock.method(secondSignal, 'addEventListener', (...args) => {
    const value = original(...args)
    secondReady.resolve()
    return value
  })
  const bob = savedFileSetup(runtime, source, 'Main.lean', null, secondSignal)
  await secondReady.promise
  controller.abort(new Error('closed editor'))
  await stopped
  finish.resolve()
  assert.equal((await bob).code, 0)
  assert.equal(calls, 1)
})
