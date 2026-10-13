#!/usr/bin/env node
// Real Docker boundary smoke; no provider, network, or existing project writes.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Runtime } from '../server/runtime.mjs'

const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || '.data')
const image =
  process.env.LEAN_PROBE_TEST_IMAGE || 'lemex-web-worker:lean-probe-646cb0ee'
const runtime = new Runtime({ dataDir, image, scope: 'helper' })
const directory = path.join(
  dataDir,
  'runtime',
  'containment-check',
  randomUUID(),
)
const root = path.join(directory, 'selected-project')
const reportDir = path.resolve('.runtime/worker-containment')
const hostOnly = path.join(directory, 'other-project', 'private.txt')
const baseline = path.join(directory, 'protected-baseline', 'Main.lean')
const environmentKey = 'STUDIO_CONTAINMENT_HOST_SENTINEL'
const previousEnvironment = process.env[environmentKey]
const report = { image, providerCalls: 0 }
await fs.mkdir(reportDir, { recursive: true })
try {
  assert.equal((await runtime.init()).ready, true, runtime.error)
  await fs.mkdir(path.join(root, '.lake'), { recursive: true })
  await fs.mkdir(path.dirname(hostOnly), { recursive: true })
  await fs.mkdir(path.dirname(baseline), { recursive: true })
  await fs.writeFile(
    hostOnly,
    'Private sibling fixture; must stay outside the worker.',
  )
  await fs.writeFile(
    baseline,
    'Protected baseline fixture; must stay outside the worker.',
  )
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await fs.symlink(hostOnly, path.join(root, 'outside-link'))
  const template = runtime.templateRoot('mathlib')
  assert(template, 'Install Mathlib preset before checking dependency mounts')
  await runtime.inheritDependencies(template, root)
  process.env[environmentKey] = randomUUID()
  const script = String.raw`
import json, os, pathlib
P = pathlib.Path
for filename in ${JSON.stringify([hostOnly, baseline, os.homedir(), '/var/run/docker.sock', '/run/docker.sock'])}:
    assert not P(filename).exists(), 'Unexpected host path exposed: ' + filename
assert not P('/workspace/outside-link').exists(), 'Absolute host symlink escaped the worker'
assert os.environ.get('${environmentKey}') is None, 'Host environment leaked into worker'
assert os.environ['HOME'] == '/home/worker'
assert os.getuid() != 0, 'Worker unexpectedly runs as root'
assert P('/workspace/Main.lean').read_text().startswith('example')
P('/workspace/agent-owned.txt').write_text('Only the selected project is writable here.')
P('/home/worker/agent-private.txt').write_text('Private agent state.')
mounts = {}
for line in P('/proc/self/mountinfo').read_text().splitlines():
    before, after = line.split(' - ', 1)
    fields = before.split()
    mounts[fields[4]] = fields[5].split(',')
assert 'ro' in mounts['/'], 'Container root is writable'
assert 'rw' in mounts['/workspace']
assert 'rw' in mounts['/home/worker']
assert 'ro' in mounts['/workspace/.lake/packages']
toolchains = {point: flags for point, flags in mounts.items() if point.startswith('/opt/lean-toolchains/')}
assert toolchains and all('ro' in flags for flags in toolchains.values())
if '/opt/dependency-lake-cache' in mounts:
    assert 'ro' in mounts['/opt/dependency-lake-cache']
assert P('/opt/tools/bin/lean-probe').exists()
assert P('/opt/lemex/bin/lemex').exists()
print(json.dumps({'uid':os.getuid(), 'home':os.environ['HOME'], 'rootReadonly':True, 'selectedWorkspaceWritable':True, 'privateHomeWritable':True, 'dependenciesReadonly':True, 'toolchainsReadonly':list(toolchains), 'hostPathsInaccessible':True, 'hostEnvironmentAbsent':True, 'network':'none'}))
`
  const result = await runtime.run(root, ['/usr/bin/python3', '-c', script], {
    network: 'none',
    timeoutMs: 30000,
  })
  assert.equal(result.code, 0, result.stderr)
  report.checks = JSON.parse(result.stdout)
  assert.equal(
    await fs.readFile(hostOnly, 'utf8'),
    'Private sibling fixture; must stay outside the worker.',
  )
  assert.equal(
    await fs.readFile(baseline, 'utf8'),
    'Protected baseline fixture; must stay outside the worker.',
  )
  assert.equal(
    await fs.readFile(path.join(root, 'agent-owned.txt'), 'utf8'),
    'Only the selected project is writable here.',
  )
  const core = runtime.templateRoot('lean')
  assert(core, 'Install the Lean preset before checking read-only builds')
  await fs.copyFile(
    path.join(core, 'lean-toolchain'),
    path.join(root, 'lean-toolchain'),
  )
  await fs.copyFile(
    path.join(core, 'lake-manifest.json'),
    path.join(root, 'lake-manifest.json'),
  )
  await fs.writeFile(
    path.join(root, 'lakefile.lean'),
    `import Lake
open Lake DSL

#eval show IO Unit from do
  let denied ← try
    IO.FS.writeFile "Main.lean" "Source was changed by executable Lake configuration!"
    pure false
  catch _ => pure true
  unless denied do throw <| IO.userError "Source write was allowed"
  IO.FS.writeFile ".lake/config-source-write-denied" "blocked"

package ProofWorkspace
@[default_target] lean_lib Main
`,
  )
  const readonlyOptions = {
    readOnlyWorkspace: true,
    writeLakeCache: true,
    network: 'none',
    timeoutMs: 60000,
  }
  const version = await runtime.run(
    root,
    ['lake', 'env', 'lean', '--version'],
    readonlyOptions,
  )
  assert.equal(version.code, 0, version.stderr || version.stdout)
  assert(version.stdout.includes('Lean (version 4.34.1'), version.stdout)
  const build = await runtime.run(root, ['lake', 'build'], readonlyOptions)
  assert.equal(build.code, 0, build.stderr || build.stdout)
  assert(
    (
      await fs.stat(path.join(root, '.lake/build/lib/lean/Main.olean'))
    ).isFile(),
  )
  assert.equal(
    await fs.readFile(
      path.join(root, '.lake/config-source-write-denied'),
      'utf8',
    ),
    'blocked',
  )
  assert.equal(
    await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
    'example : True := by trivial\n',
  )
  await fs.symlink('../Main.lean', path.join(root, '.lake/source-link'))
  const readonlyScript = String.raw`
import errno, json, pathlib
P = pathlib.Path
mounts = {}
for line in P('/proc/self/mountinfo').read_text().splitlines():
    fields = line.split(' - ', 1)[0].split()
    mounts[fields[4]] = fields[5].split(',')
assert 'ro' in mounts['/workspace']
assert 'rw' in mounts['/workspace/.lake']
assert 'ro' in mounts['/workspace/.lake/packages']
P('/workspace/.lake/worker-owned.txt').write_text('Writable build cache')
blocked = []
for filename in ['/workspace/Main.lean', '/workspace/lakefile.lean', '/workspace/new-source.lean', '/workspace/.lake/source-link', '/workspace/.lake/packages/forbidden.txt']:
    try:
        P(filename).write_text('Source write must fail')
    except OSError as error:
        assert error.errno in [errno.EROFS, errno.EACCES, errno.EPERM], str(error)
        blocked.append(filename)
    else:
        raise AssertionError('Read-only source write was allowed: ' + filename)
try:
    P('/workspace/.lake/new-hardlink').hardlink_to(P('/workspace/Main.lean'))
except OSError as error:
    assert error.errno in [errno.EXDEV, errno.EROFS, errno.EACCES, errno.EPERM], str(error)
else:
    raise AssertionError('Worker could create a writable source hardlink')
print(json.dumps({'sourceReadonly': True, 'lakeCacheWritable': True, 'dependenciesReadonly': True, 'deniedWrites': blocked, 'newSourceHardlinkDenied': True}))
`
  const readonly = await runtime.run(
    root,
    ['/usr/bin/python3', '-c', readonlyScript],
    readonlyOptions,
  )
  assert.equal(readonly.code, 0, readonly.stderr)
  report.readonlyBuild = {
    ...JSON.parse(readonly.stdout),
    leanVersion: version.stdout.trim(),
    lakeBuild: build.stdout.trim(),
    executableConfigSourceWriteDenied: true,
    sourceUnchanged: true,
  }
  await fs.link(
    path.join(root, 'Main.lean'),
    path.join(root, '.lake/preexisting-hardlink'),
  )
  await assert.rejects(
    runtime.run(root, ['true'], readonlyOptions),
    /must not contain hardlinked files/,
  )
  report.readonlyBuild.preexistingSourceHardlinkRejected = true
  report.imageId = runtime.imageId
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack || error.message
  process.exitCode = 1
} finally {
  if (previousEnvironment === undefined) delete process.env[environmentKey]
  else process.env[environmentKey] = previousEnvironment
  await runtime.shutdown()
  try {
    await runtime.clearInheritedDependencies(root)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      report.cleanupError = error.message
      report.passed = false
      process.exitCode = 1
    }
  }
  const key = createHash('sha256').update(root).digest('hex')
  await fs.rm(path.join(dataDir, 'runtime', 'homes', key), {
    recursive: true,
    force: true,
  })
  await fs.rm(directory, { recursive: true, force: true })
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
}
