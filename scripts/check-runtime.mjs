#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../server/runtime.mjs'
import { verifyPackagedRuntime } from './ci/runtime-provenance.mjs'

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const dataDir = path.join(projectDir, '.runtime/runtime-check')
const root = path.join(dataDir, 'project')
await fs.mkdir(root, { recursive: true })
await fs.writeFile(
  path.join(root, 'lean-toolchain'),
  'leanprover/lean4:v4.34.1\n',
)
await fs.writeFile(
  path.join(root, 'Main.lean'),
  'example (a b : Nat) : a + b = b + a := by\n  exact Nat.add_comm a b\n',
)
const memory = process.env.STUDIO_WORKER_MEMORY || '4g'
const runtime = new Runtime({ dataDir, maxConcurrent: 2, memory })
try {
  await runtime.init()
  assert.equal(runtime.info().ready, true, runtime.info().error)
  const probeFiles = await runtime.run(
    root,
    [
      'python3',
      '-I',
      '-c',
      'import json, os, pathlib; assert os.getuid() != 0; root = pathlib.Path("/opt/lean-probe-repls"); pins = json.loads((root / "pins.json").read_text()); [(root / version / "lean-toolchain").read_text() for version in pins]',
    ],
    { network: 'none', cleanHome: true },
  )
  assert.equal(probeFiles.code, 0, probeFiles.stderr)
  const actualNative = await promisify(execFile)('docker', [
    'run',
    '--rm',
    '--read-only',
    '--network',
    'none',
    runtime.imageId,
    'cat',
    '/opt/lemex/lemex-install.json',
  ])
  const actualProvenance = JSON.parse(actualNative.stdout)
  assert.equal(
    runtime.info().lemexCommit,
    actualProvenance.source_commit ||
      actualProvenance.native_build_commit ||
      null,
  )
  assert.equal(
    runtime.info().lemexNativeBuildCommit,
    actualProvenance.native_build_commit || null,
  )
  assert.equal(runtime.info().lemexVersion, actualProvenance.version || null)
  if (actualProvenance.provenance_verification === 'npm_registry_integrity')
    await verifyPackagedRuntime(actualProvenance, projectDir)
  await runtime.prepareToolchain('leanprover/lean4:v4.34.1')
  const proof = await runtime.run(root, [
    'lean',
    '-o',
    'Main.olean',
    'Main.lean',
  ])
  assert.equal(proof.code, 0, proof.stderr)
  const kernel = await runtime.run(root, ['leanchecker', '-v', 'Main'], {
    env: { LEAN_PATH: '/workspace' },
  })
  assert.equal(kernel.code, 0, kernel.stderr)
  const priorHome = await runtime.home(root)
  await fs.writeFile(
    path.join(priorHome, 'build-controlled-marker'),
    'untrusted build state',
  )
  const audit = await runtime.run(
    root,
    [
      'python3',
      '-I',
      '-c',
      `import os,pathlib,subprocess,tempfile
assert 'LEMEX_API_KEY' not in os.environ
assert not pathlib.Path('/home/worker/build-controlled-marker').exists()
for file in ['/home/worker/untrusted', '/workspace/untrusted']:
 try:
  pathlib.Path(file).write_text('forbidden')
  raise AssertionError('Verification mount was writable')
 except OSError:
  pass
with tempfile.TemporaryDirectory() as directory:
 subprocess.run(['lean','-o',directory+'/Main.olean','Main.lean'],check=True)
 env=dict(os.environ);env['LEAN_PATH']=directory
 subprocess.run(['leanchecker','-v','Main'],env=env,check=True)`,
    ],
    { readOnlyWorkspace: true, freshHome: true, readOnlyHome: true },
  )
  assert.equal(audit.code, 0, audit.stderr)
  const isolation = await runtime.run(root, [
    'python3',
    '-c',
    `import os, json\nassert os.getcwd() == '/workspace'\nassert os.environ['HOME'] == '/home/worker'\nassert not os.path.exists('/var/run/docker.sock')\nassert not os.path.exists(${JSON.stringify(path.join(os.homedir(), '.lemex/auth.json'))})\ntry:\n open('/etc/worker-write-test', 'w')\n raise AssertionError('Root filesystem was writable')\nexcept OSError:\n pass\nprint('source/home/container isolation verified')`,
  ])
  assert.equal(isolation.code, 0, isolation.stderr)
  const env = await runtime.run(
    root,
    [
      'python3',
      '-c',
      'import os; assert os.getenv("LEMEX_TEST_SECRET") == "private-only"; print("scoped env verified")',
    ],
    { env: { LEMEX_TEST_SECRET: 'private-only' } },
  )
  assert.equal(env.code, 0, env.stderr)
  const absent = await runtime.run(root, [
    'python3',
    '-c',
    'import os; assert "LEMEX_TEST_SECRET" not in os.environ',
  ])
  assert.equal(absent.code, 0, absent.stderr)
  await fs.mkdir(path.join(root, '.lake/packages/shared'), { recursive: true })
  await fs.writeFile(
    path.join(root, '.lake/packages/shared/value'),
    'shared dependency',
  )
  const sourceHome = await runtime.home(root)
  await fs.mkdir(path.join(sourceHome, '.cache/lake/artifacts'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(sourceHome, '.cache/lake/artifacts/shared.art'),
    'immutable artifact',
  )
  await runtime.inheritDependencies(root, root)
  const candidate = path.join(dataDir, 'candidate')
  await fs.mkdir(candidate, { recursive: true })
  await runtime.inheritDependencies(root, candidate)
  const shared = await runtime.run(candidate, [
    'python3',
    '-c',
    `from pathlib import Path
assert Path('.lake/packages/shared/value').read_text() == 'shared dependency'
assert Path('/home/worker/.cache/lake/artifacts/shared.art').read_text() == 'immutable artifact'
for file in ['.lake/packages/shared/value', '/home/worker/.cache/lake/artifacts/shared.art']:
 try:
  Path(file).write_text('corrupted')
  raise AssertionError('Shared source was writable')
 except OSError:
  pass
Path('/home/worker/.cache/lake/artifacts/private.art').write_text('private new artifact')
print('readonly packages and immutable cache sharing verified')`,
  ])
  assert.equal(shared.code, 0, shared.stderr)
  assert.equal(
    await fs.readFile(
      path.join(sourceHome, '.cache/lake/artifacts/shared.art'),
      'utf8',
    ),
    'immutable artifact',
  )
  assert.equal(await runtime.clearInheritedDependencies(root), true)
  const timeout = await runtime.run(root, ['sh', '-c', 'sleep 120 & wait'], {
    timeoutMs: 800,
  })
  assert.equal(timeout.timedOut, true)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const controller = new AbortController()
  const aborting = runtime.run(root, ['sh', '-c', 'sleep 120 & wait'], {
    signal: controller.signal,
  })
  setTimeout(
    () => controller.abort(new Error('User stopped verification')),
    500,
  )
  const stopped = await aborting
  assert.equal(stopped.cancelled, true)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const { stdout: survivors } = await promisify(execFile)('docker', [
    'ps',
    '-aq',
    '--filter',
    `label=lemex-web.owner=${runtime.owner}`,
  ])
  assert.equal(
    survivors.trim(),
    '',
    'Cancelled worker containers survived cleanup',
  )
  assert.throws(() => runtime.spawn('/tmp', ['true']), /owned data directory/)
  assert.throws(
    () => runtime.spawn(root, ['true'], { env: { HOME: '/host' } }),
    /Unsupported worker environment/,
  )
  const tamperRoot = path.join(dataDir, 'tamper')
  await fs.mkdir(tamperRoot, { recursive: true })
  const tamperHome = await runtime.home(tamperRoot)
  const tamper = await runtime.run(tamperRoot, [
    'sh',
    '-c',
    'rm -rf "$HOME/.elan/toolchains" && ln -s /host-private/toolchains "$HOME/.elan/toolchains"',
  ])
  assert.equal(tamper.code, 0, tamper.stderr)
  await assert.rejects(runtime.home(tamperRoot), /managed worker directory/)
  await fs.unlink(path.join(tamperHome, '.elan/toolchains'))
  const running = await runtime.run(root, ['lemex', '--version'])
  assert.equal(running.code, 0, running.stderr)
  const mergeRoots = ['merge-a', 'merge-b', 'merge-c'].map((name) =>
    path.join(dataDir, name),
  )
  for (const mergeRoot of mergeRoots) {
    await fs.mkdir(path.join(mergeRoot, '.lake/packages/fixture'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(mergeRoot, '.lake/packages/fixture/value'),
      'fixture',
    )
  }
  const secondRuntime = new Runtime({ dataDir, memory })
  await secondRuntime.init()
  try {
    await Promise.all([
      runtime.inheritDependencies(mergeRoots[0], mergeRoots[0]),
      secondRuntime.inheritDependencies(mergeRoots[1], mergeRoots[1]),
    ])
    const firstRegistry = JSON.parse(
      await fs.readFile(
        path.join(dataDir, 'runtime/dependencies.json'),
        'utf8',
      ),
    )
    assert.equal(firstRegistry[mergeRoots[0]], mergeRoots[0])
    assert.equal(firstRegistry[mergeRoots[1]], mergeRoots[1])
    await Promise.all([
      runtime.clearInheritedDependencies(mergeRoots[0]),
      secondRuntime.inheritDependencies(mergeRoots[2], mergeRoots[2]),
    ])
    const registry = JSON.parse(
      await fs.readFile(
        path.join(dataDir, 'runtime/dependencies.json'),
        'utf8',
      ),
    )
    assert.equal(registry[mergeRoots[0]], undefined)
    assert.equal(registry[mergeRoots[1]], mergeRoots[1])
    assert.equal(registry[mergeRoots[2]], mergeRoots[2])
  } finally {
    await secondRuntime.shutdown()
  }

  const reapingDir = path.join(dataDir, 'reaping', randomUUID())
  const priorServer = new Runtime({
    dataDir: reapingDir,
    scope: 'server',
    memory,
  })
  const helper = new Runtime({ dataDir: reapingDir, memory })
  const unrelated = new Runtime({
    dataDir: path.join(reapingDir, 'other'),
    scope: 'server',
    memory,
  })
  const fixtureIds = []
  const exec = promisify(execFile)
  const fixture = async (instance, scope) => {
    const { stdout } = await exec('docker', [
      'run',
      '-d',
      '--rm',
      '--read-only',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '0.25',
      '--memory',
      '64m',
      '--pids-limit',
      '32',
      '--label',
      `lemex-web.instance=${instance}`,
      '--label',
      `lemex-web.scope=${scope}`,
      '--label',
      `lemex-web.owner=fixture-${randomUUID()}`,
      runtime.imageId,
      'sleep',
      '120',
    ])
    const id = stdout.trim()
    fixtureIds.push(id)
    return id
  }
  let restarted
  try {
    await priorServer.init()
    await helper.init()
    await unrelated.init()
    const orphan = await fixture(priorServer.instance, 'server')
    const helperWorker = await fixture(helper.instance, 'helper')
    const unrelatedWorker = await fixture(unrelated.instance, 'server')
    restarted = new Runtime({ dataDir: reapingDir, scope: 'server', memory })
    await restarted.init()
    assert.equal(restarted.info().ready, true, restarted.info().error)
    assert.equal(restarted.instance, priorServer.instance)
    assert.equal(restarted.info().reaped, 1)
    await assert.rejects(exec('docker', ['inspect', orphan]))
    for (const id of [helperWorker, unrelatedWorker]) {
      const { stdout } = await exec('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        id,
      ])
      assert.equal(
        stdout.trim(),
        'true',
        'Startup reaped a helper or different data directory',
      )
    }
  } finally {
    if (fixtureIds.length)
      await exec('docker', ['rm', '-f', ...fixtureIds]).catch(() => {})
    await priorServer.shutdown()
    await helper.shutdown()
    await unrelated.shutdown()
    await restarted?.shutdown()
  }
  console.log(
    'PASS: Lean compilation and kernel replay, private source/home, readonly dependencies/artifacts, scoped secrets, abort/timeout cleanup, managed symlink guard, atomic concurrent registries, server-only orphan reaping, native Lemex',
  )
} finally {
  await runtime.shutdown()
}
