import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dependencyFailureMessage,
  certifyDependencyBuilds,
  setupInfrastructureFailure,
} from '../pinned-lake.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('dependency permission/build failures are separated from user proof failures', () => {
  for (const stderr of [
    'error: read-only file system (error code: 30)\n  file: /workspace/.lake/packages/proofwidgets/widget/package-lock.json.hash',
    '/workspace/.lake/packages/aesop/Aesop.lean:2:0: error: missing module',
    "error: object file '/workspace/.lake/packages/proofwidgets/ProofWidgets.olean' of module ProofWidgets does not exist",
  ])
    assert.match(dependencyFailureMessage({ stderr }), /Refresh setup/)
  assert.equal(
    dependencyFailureMessage({
      stderr: 'Main.lean:3:0: error: unsolved goals',
    }),
    null,
  )
})

test('recoverable dependency errors allow setup repair while resource and network failures skip it', () => {
  const missing = {
    code: 1,
    stderr:
      "error: object file '/workspace/.lake/packages/proofwidgets/ProofWidgets.olean' of module ProofWidgets does not exist",
  }
  assert.equal(setupInfrastructureFailure(missing), false)
  assert.equal(setupInfrastructureFailure({ ...missing, timedOut: true }), true)
  assert.equal(setupInfrastructureFailure({ code: 137 }), true)
  assert.equal(
    setupInfrastructureFailure({
      code: 1,
      stderr: 'curl: (6) Could not resolve host: github.com',
    }),
    true,
  )
})

test('private dependency environments replay under the same readonly mounts and surface failures', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-private-dep-replay-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(
    path.join(root, 'lean-toolchain'),
    'leanprover/lean4:v4.34.1\n',
  )
  const calls = []
  const runtime = {
    run: async (_root, args, options) => {
      calls.push({ args, options })
      return {
        code: 1,
        stdout: '',
        stderr:
          'error: read-only file system\n file: /workspace/.lake/packages/proofwidgets/widget/package-lock.json.hash',
      }
    },
  }
  await assert.rejects(
    certifyDependencyBuilds(runtime, root, {
      packages: [{ type: 'git', name: 'proofwidgets', inherited: true }],
    }),
    /Refresh setup/,
  )
  assert.equal(calls[0].options.readOnlyWorkspace, true)
  assert.equal(calls[0].options.network, 'none')
})

async function replayFixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-dep-recovery-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = 'example : True := by trivial\n'
  await fs.writeFile(path.join(root, 'Main.lean'), source)
  await fs.writeFile(
    path.join(root, 'lean-toolchain'),
    'leanprover/lean4:v4.34.1\n',
  )
  const manifest = { packages: [{ type: 'git', name: 'proofwidgets' }] }
  await fs.writeFile(
    path.join(root, 'lake-manifest.json'),
    JSON.stringify(manifest),
  )
  return { root, source, manifest }
}

const missingBuildFile = {
  code: 1,
  stdout: '',
  stderr:
    'read-only file system: /workspace/.lake/packages/proofwidgets/widget/package-lock.json.hash',
}

test('missing dependency artifacts are rebuilt once before readonly certification succeeds', async (t) => {
  const { root, source, manifest } = await replayFixture(t)
  let rebuilt = false,
    rebuilds = 0
  const calls = []
  const output = []
  await certifyDependencyBuilds(
    {
      run: async (_root, args, options) => {
        calls.push({ args, options })
        return rebuilt ? { code: 0, stdout: '', stderr: '' } : missingBuildFile
      },
    },
    root,
    manifest,
    {
      rebuild: async () => {
        rebuilds++
        rebuilt = true
      },
      onOutput: (text) => output.push(text),
    },
  )
  assert.equal(rebuilds, 1)
  assert.equal(calls.length, 2)
  for (const { args, options } of calls) {
    assert.equal(args.at(-1), '@proofwidgets')
    assert.equal(options.readOnlyWorkspace, true)
    assert.equal(options.writeLakeCache, true)
    assert.equal(options.network, 'none')
    assert(!Object.hasOwn(options, 'rebuild'))
  }
  assert.match(output.join(''), /Preparing additional dependency build files/)
  assert.equal(await fs.readFile(path.join(root, 'Main.lean'), 'utf8'), source)
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, 'lake-manifest.json'))),
    manifest,
  )
})

test('dependency recovery is bounded across the entire graph and never retries infrastructure failures', async (t) => {
  const { root, manifest } = await replayFixture(t)
  for (const failure of [
    missingBuildFile,
    { ...missingBuildFile, code: 137 },
    { ...missingBuildFile, timedOut: true },
  ]) {
    let checks = 0,
      rebuilds = 0
    await assert.rejects(
      certifyDependencyBuilds(
        {
          run: async () => {
            checks++
            return failure
          },
        },
        root,
        manifest,
        {
          rebuild: async () => {
            rebuilds++
          },
        },
      ),
    )
    const recoverable = failure.code === 1 && !failure.timedOut
    assert.equal(rebuilds, recoverable ? 1 : 0)
    assert.equal(checks, recoverable ? 2 : 1)
  }
  let checks = 0,
    rebuilds = 0
  await assert.rejects(
    certifyDependencyBuilds(
      { run: async () => (++checks === 2 ? { code: 0 } : missingBuildFile) },
      root,
      { packages: [...manifest.packages, { type: 'git', name: 'verso' }] },
      {
        rebuild: async () => {
          rebuilds++
        },
      },
    ),
  )
  assert.equal(rebuilds, 1)
  assert.equal(checks, 3)
})

test('cancelling artifact recovery prevents further certification', async (t) => {
  const { root, manifest } = await replayFixture(t)
  const controller = new AbortController()
  let checks = 0
  await assert.rejects(
    certifyDependencyBuilds(
      {
        run: async () => {
          checks++
          return missingBuildFile
        },
      },
      root,
      manifest,
      {
        signal: controller.signal,
        rebuild: async () => controller.abort(new Error('Recovery stopped')),
      },
    ),
    /Recovery stopped/,
  )
  assert.equal(checks, 1)
})

test('artifact recovery recertifies earlier targets after the last writable build', async (t) => {
  const { root, manifest } = await replayFixture(t)
  let rebuilt = false
  const targets = []
  await certifyDependencyBuilds(
    {
      run: async (_root, args) => {
        targets.push(args.at(-1))
        return args.at(-1) === '@verso' && !rebuilt
          ? missingBuildFile
          : { code: 0 }
      },
    },
    root,
    { packages: [...manifest.packages, { type: 'git', name: 'verso' }] },
    {
      rebuild: async () => {
        rebuilt = true
      },
    },
  )
  assert.deepEqual(targets, [
    '@proofwidgets',
    '@verso',
    '@proofwidgets',
    '@verso',
  ])
})
