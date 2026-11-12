import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { toolchainName } from '../lean-check.mjs'
import { Runtime } from '../runtime.mjs'

const gib = 1024 ** 3
const hex = 'f00d'.repeat(16)
const imageId = `sha256:${hex}`
const uid = process.getuid?.() || 1000
const gid = process.getgid?.() || 1000
const user = `${uid}:${gid}`
const toolchain = 'leanprover/lean4:v4.34.1'
const seccomp = fileURLToPath(
  new URL('../../deploy/lake-check-seccomp.json', import.meta.url),
)
const kernelCheck = {
  kernelCheck: true,
  readOnlyWorkspace: true,
  writeLakeCache: true,
  freshHome: true,
}
const podmanPins = [
  '--cgroups=enabled',
  '--pull=never',
  '--http-proxy=false',
  '--env-host=false',
]
const recordedEnv = [
  'HOME',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'CONTAINERS_STORAGE_CONF',
  'LEANFLOW_ENGINE_FIXTURE',
]
const dockerInfo = {
  ServerVersion: '27.5.1',
  MemTotal: 32 * gib,
  MemoryLimit: true,
  SwapLimit: true,
}

// Rootless Podman 5.7 running as this test's account, with systemd
// delegating cpu, io, memory and pids.
function podmanInfo(change = () => {}) {
  const mapping = (id) => [
    { container_id: 0, host_id: id, size: 1 },
    { container_id: 1, host_id: 165536, size: 65536 },
  ]
  const info = {
    host: {
      cgroupManager: 'systemd',
      cgroupVersion: 'v2',
      cgroupControllers: ['cpu', 'io', 'memory', 'pids'],
      idMappings: { uidmap: mapping(uid), gidmap: mapping(gid) },
      memTotal: 32 * gib,
      ociRuntime: { name: 'crun', path: '/usr/bin/crun' },
      rootlessNetworkCmd: 'pasta',
      security: {
        apparmorEnabled: false,
        rootless: true,
        seccompEnabled: true,
        seccompProfilePath: '/usr/share/containers/seccomp.json',
        selinuxEnabled: false,
      },
      serviceIsRemote: false,
    },
    store: { graphDriverName: 'overlay' },
    version: { APIVersion: '5.7.0', Version: '5.7.0' },
  }
  change(info)
  return info
}

function engineScript(calls, config) {
  return `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
const env = Object.fromEntries(${JSON.stringify(recordedEnv)}.map((key) => [key, process.env[key] ?? null]))
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, env }) + String.fromCharCode(10))
const config = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'))
if (args[0] === 'info')
  console.log(args.at(-1) === '{{json .SecurityOptions}}' ? '[]' : JSON.stringify(config.info))
if (args[0] === 'image') console.log(config.imageId)
if (args[0] === 'run') {
  if (args.includes('/opt/lemex/lemex-install.json')) console.log('{"version":"fixture"}')
  else if (args.includes('/verify/bin/lean')) console.log('Lean (version 4.34.1)')
  else if (args.includes('/opt/tex-compile-worker.py')) {
    const artifacts = { 'result.json': Buffer.from('{"success":true}').toString('base64') }
    console.log('LEANFLOW_TEX_ARTIFACTS:' + args.at(-1) + ':' + JSON.stringify({ artifacts }))
  } else if (args.includes('hold')) {
    console.log('started')
    setInterval(() => {}, 1000)
  } else console.log(JSON.stringify({ args, token: process.env.FIXTURE_TOKEN ?? null }))
}
`
}

async function fixture(t, { kind = 'podman', info, image, options = {} } = {}) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-engine-')),
  )
  const dataDir = path.join(directory, 'data')
  const root = path.join(dataDir, 'project')
  const output = path.join(dataDir, 'tex-output')
  const hostToolchainDir = path.join(directory, 'host-toolchains')
  const executable = path.join(directory, kind)
  const calls = path.join(directory, 'calls.jsonl')
  const config = path.join(directory, 'config.json')
  const lean = path.join(hostToolchainDir, toolchainName(toolchain), 'bin/lean')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(output)
  await fs.mkdir(path.dirname(lean), { recursive: true })
  await fs.writeFile(lean, 'fixture toolchain')
  await fs.writeFile(calls, '')
  await fs.writeFile(
    config,
    JSON.stringify({
      info: info ?? (kind === 'docker' ? dockerInfo : podmanInfo()),
      // Docker reports prefixed image IDs; Podman reports bare digests.
      imageId: image ?? (kind === 'docker' ? imageId : hex),
    }),
  )
  await fs.writeFile(executable, engineScript(calls, config), { mode: 0o700 })
  const runtime = new Runtime({
    dataDir,
    hostToolchainDir,
    kernelExportMaxBytes: 1024 * 1024,
    ...(kind === 'docker'
      ? { docker: executable }
      : {
          engineKind: 'podman',
          engineExecutable: executable,
          engineHostAppArmor: false,
        }),
    ...options,
  })
  t.after(async () => {
    await runtime.shutdown()
    await fs.rm(directory, { recursive: true, force: true })
  })
  await runtime.init()
  return {
    runtime,
    root,
    output,
    executable,
    calls: async () =>
      (await fs.readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  }
}

const values = (args, option) =>
  args.flatMap((value, index) => (value === option ? [args[index + 1]] : []))

const commands = (calls, command) =>
  calls.filter((call) => call.args[0] === command).map((call) => call.args)

test('Runtime keeps docker injection compatible and validates engine options', async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-engine-options-'),
  )
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const defaults = new Runtime({ dataDir })
  assert.equal(defaults.docker, 'docker')
  assert.equal(defaults.engine.kind, 'docker')
  const info = defaults.info()
  assert.equal(info.engineKind, 'docker')
  for (const key of [
    'ready',
    'error',
    'image',
    'imageId',
    'dockerVersion',
    'lemexCommit',
    'lemexNativeBuildCommit',
    'lemexVersion',
    'scope',
    'instance',
    'reaped',
    'active',
    'usedSlots',
    'queued',
    'maxConcurrent',
    'configuredMaxConcurrent',
    'limits',
    'toolchains',
  ])
    assert(Object.hasOwn(info, key), key)
  assert.equal(
    new Runtime({ dataDir, docker: '/fixture/docker' }).engine.executable,
    '/fixture/docker',
  )
  assert.equal(
    new Runtime({ dataDir, engineExecutable: '/fixture/docker' }).docker,
    '/fixture/docker',
  )
  const same = { dataDir, docker: '/fixture/a', engineExecutable: '/fixture/a' }
  assert.equal(new Runtime(same).docker, '/fixture/a')
  assert.throws(
    () =>
      new Runtime({
        dataDir,
        docker: '/fixture/a',
        engineExecutable: '/fixture/b',
      }),
    /Choose either/,
  )
  const podman = new Runtime({ dataDir, engineKind: 'podman' })
  assert.equal(podman.docker, 'podman')
  assert.equal(podman.info().engineKind, 'podman')
  assert.equal(
    new Runtime({ dataDir, engineKind: 'podman', docker: '/fixture/podman' })
      .engine.executable,
    '/fixture/podman',
  )
  assert.throws(
    () => new Runtime({ dataDir, engineKind: 'containerd' }),
    /docker or podman/,
  )
  assert.throws(
    () =>
      new Runtime({
        dataDir,
        engineKind: 'podman',
        engineEnv: { REGISTRY_AUTH_FILE: '/fixture/auth.json' },
      }),
    /Unsupported Podman environment setting/,
  )
  defaults.docker = '/fixture/replaced'
  assert.equal(defaults.engine.executable, '/fixture/replaced')
})

test('Docker keeps its existing host, worker and cleanup commands and inherited environment', async (t) => {
  process.env.LEANFLOW_ENGINE_FIXTURE = 'inherited'
  t.after(() => delete process.env.LEANFLOW_ENGINE_FIXTURE)
  const f = await fixture(t, { kind: 'docker' })
  const { runtime } = f
  assert.equal(runtime.ready, true, runtime.error)
  assert.equal(runtime.docker, f.executable)
  assert.equal(runtime.info().engineKind, 'docker')
  assert.equal(runtime.info().dockerVersion, '27.5.1')
  assert.equal(runtime.imageId, imageId)
  const kernel = JSON.parse(
    (await runtime.run(f.root, ['lake', 'check'], kernelCheck)).stdout,
  )
  const calls = await f.calls()
  const startup = calls.slice(0, 5).map((call) => call.args)
  assert.deepEqual(startup, [
    ['info', '--format', '{{json .}}'],
    ['image', 'inspect', '--format', '{{.Id}}', runtime.image],
    [
      'run',
      '--rm',
      '--label',
      `lemex-web.owner=${runtime.owner}`,
      '--label',
      `lemex-web.instance=${runtime.instance}`,
      '--label',
      'lemex-web.scope=helper',
      '--read-only',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--memory-swap',
      '4g',
      '--pids-limit',
      '512',
      imageId,
      '/usr/bin/cat',
      '/opt/lemex/lemex-install.json',
    ],
    ['info', '--format', '{{json .SecurityOptions}}'],
    ['ps', '-q'],
  ])
  assert.deepEqual(kernel.args.slice(0, 5), [
    'run',
    '--rm',
    '-i',
    '--init',
    '--name',
  ])
  assert.deepEqual(values(kernel.args, '--security-opt'), [
    'no-new-privileges',
    `seccomp=${seccomp}`,
    'systempaths=unconfined',
  ])
  for (const podmanOnly of [
    ...podmanPins,
    '--userns=keep-id',
    '--read-only-tmpfs=false',
    'unmask=ALL',
  ])
    assert(!kernel.args.includes(podmanOnly), podmanOnly)
  const name = values(kernel.args, '--name')[0]
  assert.deepEqual(commands(calls, 'rm').at(-1), ['rm', '-f', name])
  for (const call of calls)
    assert.equal(call.env.LEANFLOW_ENGINE_FIXTURE, 'inherited')
})

test('Docker rejects a malformed worker image identity before starting workers', async (t) => {
  const f = await fixture(t, { kind: 'docker', image: hex })
  assert.equal(f.runtime.ready, false)
  assert.match(
    f.runtime.error,
    /invalid image identity\. Run scripts\/build-worker\.sh/,
  )
  assert.deepEqual(commands(await f.calls(), 'run'), [])
})

test('rootless Podman host, worker, maintenance and TeX calls all use the adapter', async (t) => {
  const personal = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = '/home/person/.config'
  t.after(() => {
    if (personal === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = personal
  })
  const engineEnv = {
    HOME: '/var/lib/leanflow-podman/home',
    XDG_RUNTIME_DIR: '/run/leanflow-podman',
    CONTAINERS_STORAGE_CONF: '/etc/leanflow/storage.conf',
  }
  const f = await fixture(t, { options: { engineEnv } })
  const { runtime } = f
  assert.equal(runtime.ready, true, runtime.error)
  assert.equal(runtime.imageId, imageId)
  assert.equal(runtime.info().engineKind, 'podman')
  assert.equal(runtime.info().dockerVersion, '5.7.0')
  assert.equal(runtime.info().limits.hostMemoryBytes, 32 * gib)
  const ordinary = JSON.parse(
    (
      await runtime.run(f.root, ['true'], {
        env: { FIXTURE_TOKEN: 'worker-value' },
      })
    ).stdout,
  )
  assert.equal(ordinary.token, 'worker-value')
  await runtime.run(f.root, ['lake', 'check'], kernelCheck)
  await runtime.prepareToolchain(toolchain)
  assert.equal(
    (await runtime.runTex(f.root, f.output, { rootFile: 'main.tex' })).code,
    0,
  )
  assert.equal(runtime.children.size, 0)
  const calls = await f.calls()
  // Host calls and spawned workers use the dedicated engine storage and never
  // the operator's personal home-derived configuration.
  for (const call of calls)
    assert.deepEqual(
      {
        HOME: call.env.HOME,
        XDG_RUNTIME_DIR: call.env.XDG_RUNTIME_DIR,
        CONTAINERS_STORAGE_CONF: call.env.CONTAINERS_STORAGE_CONF,
        XDG_CONFIG_HOME: call.env.XDG_CONFIG_HOME,
      },
      { ...engineEnv, XDG_CONFIG_HOME: null },
      call.args.join(' '),
    )
  assert(!calls.some((call) => call.args.includes('{{json .SecurityOptions}}')))
  const runs = commands(calls, 'run')
  assert.equal(runs.length, 5)
  const [provenance, ordinaryRun, kernelRun, verify, texRun] = runs
  assert(provenance.includes('/opt/lemex/lemex-install.json'))
  assert(verify.includes('/verify/bin/lean'))
  assert(texRun.includes('/opt/tex-compile-worker.py'))
  for (const args of runs) {
    assert.deepEqual(args.slice(0, 2), ['run', '--userns=keep-id'])
    assert.deepEqual(values(args, '--user'), [user])
    assert.equal(
      args[args.indexOf('--read-only') + 1],
      '--read-only-tmpfs=false',
    )
    assert.deepEqual(values(args, '--cap-drop'), ['ALL'])
    assert(values(args, '--security-opt').includes('no-new-privileges'))
    assert(!args.includes('systempaths=unconfined'))
    assert(args.includes(imageId))
    assert.deepEqual(values(args, '--memory'), values(args, '--memory-swap'))
    for (const pin of podmanPins) assert(args.includes(pin), pin)
  }
  assert.deepEqual(values(kernelRun, '--security-opt'), [
    'no-new-privileges',
    `seccomp=${seccomp}`,
    'unmask=ALL',
  ])
  assert.deepEqual(values(kernelRun, '--memory'), ['12g'])
  for (const args of [provenance, ordinaryRun, verify, texRun])
    assert(!values(args, '--security-opt').includes('unmask=ALL'))
  assert.deepEqual(values(texRun, '--log-driver'), ['none'])
  assert.deepEqual(values(texRun, '--pids-limit'), ['128'])
  const removals = commands(calls, 'rm')
  assert(removals.length >= 4)
  for (const args of removals)
    assert.deepEqual(args.slice(0, 4), ['rm', '-f', '-t', '0'])
  for (const args of [ordinaryRun, kernelRun, verify, texRun]) {
    const name = values(args, '--name')[0]
    assert(
      removals.some((removal) => removal.at(-1) === name),
      name,
    )
  }
})

test('Docker verifies private imported toolchains with the service UID and read-only network isolation', async (t) => {
  const f = await fixture(t, { kind: 'docker' })
  await f.runtime.prepareToolchain(toolchain)
  const verify = commands(await f.calls(), 'run').find((args) =>
    args.includes('/verify/bin/lean'),
  )
  assert.ok(verify)
  assert.deepEqual(values(verify, '--user'), [user])
  assert.deepEqual(values(verify, '--network'), ['none'])
  assert.deepEqual(values(verify, '--cap-drop'), ['ALL'])
  assert.ok(verify.includes('--read-only'))
})

test('Podman cancellation keeps capacity until immediate removal and rejects engine settings as worker variables', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    async () =>
      f.runtime.run(f.root, ['true'], {
        env: { XDG_RUNTIME_DIR: '/tmp/elsewhere' },
      }),
    /Unsupported worker environment key: XDG_RUNTIME_DIR/,
  )
  const controller = new AbortController()
  let started
  const running = new Promise((resolve) => (started = resolve))
  const task = f.runtime.run(f.root, ['hold'], {
    signal: controller.signal,
    onOutput: () => started(),
  })
  await running
  const [child] = f.runtime.children
  assert.equal(f.runtime.info().usedSlots, 1)
  controller.abort()
  assert.equal((await task).cancelled, true)
  await child.workerStopped
  assert.equal(f.runtime.children.size, 0)
  assert.equal(f.runtime.info().usedSlots, 0)
  assert.deepEqual(commands(await f.calls(), 'rm').at(-1), [
    'rm',
    '-f',
    '-t',
    '0',
    child.containerName,
  ])
})

test('Podman without delegated cgroup controllers never starts a worker', async (t) => {
  const f = await fixture(t, {
    info: podmanInfo((info) => (info.host.cgroupControllers = ['memory'])),
  })
  assert.equal(f.runtime.ready, false)
  assert.match(f.runtime.error, /cpu, pids cgroup controllers/)
  assert.equal(f.runtime.info().maxConcurrent, 0)
  await assert.rejects(async () => f.runtime.run(f.root, ['true']), {
    status: 503,
  })
  assert.deepEqual(
    (await f.calls()).map((call) => call.args[0]),
    ['info'],
  )
})

test('Podman under another account or on an AppArmor host fails closed', async (t) => {
  for (const [settings, pattern] of [
    [
      {
        info: podmanInfo((info) => {
          info.host.idMappings.uidmap[0].host_id = uid + 1
        }),
      },
      /service account/,
    ],
    [{ options: { engineHostAppArmor: true } }, /AppArmor/],
  ]) {
    const f = await fixture(t, settings)
    assert.equal(f.runtime.ready, false)
    assert.match(f.runtime.error, pattern)
    assert.equal(f.runtime.info().maxConcurrent, 0)
    assert.deepEqual(commands(await f.calls(), 'run'), [])
  }
})
