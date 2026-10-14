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
