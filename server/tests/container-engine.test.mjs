import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ContainerEngine,
  hostAppArmorEnabled,
  normalizeImageId,
  normalizePodmanInfo,
  translatePodmanArgs,
  translatePodmanRun,
} from '../container-engine.mjs'

const gib = 1024 ** 3
const hex = 'c0ffee'.repeat(10) + 'abcd'
const imageId = `sha256:${hex}`
const seccomp = '/srv/leanflow/deploy/lake-check-seccomp.json'
const rootless = { rootless: true, user: '1001:1001', apparmor: false }
const rootful = { rootless: false, user: null, apparmor: false }

// Shape of `podman info --format '{{json .}}'` for rootless Podman 5.7 with
// systemd delegating cpu, io, memory and pids to the service account.
function podmanInfo(change = () => {}) {
  const info = {
    host: {
      arch: 'amd64',
      buildahVersion: '1.42.0',
      cgroupManager: 'systemd',
      cgroupVersion: 'v2',
      cgroupControllers: ['cpu', 'io', 'memory', 'pids'],
      conmon: { path: '/usr/bin/conmon', version: 'conmon version 2.1.13' },
      cpus: 16,
      databaseBackend: 'sqlite',
      eventLogger: 'journald',
      hostname: 'worker-fixture',
      idMappings: {
        gidmap: [
          { container_id: 0, host_id: 1001, size: 1 },
          { container_id: 1, host_id: 165536, size: 65536 },
        ],
        uidmap: [
          { container_id: 0, host_id: 1001, size: 1 },
          { container_id: 1, host_id: 165536, size: 65536 },
        ],
      },
      kernel: '6.8.0-fixture',
      logDriver: 'journald',
      memFree: 8 * gib,
      memTotal: 32 * gib,
      networkBackend: 'netavark',
      ociRuntime: { name: 'crun', path: '/usr/bin/crun' },
      os: 'linux',
      remoteSocket: { exists: false, path: '/run/user/1001/podman.sock' },
      rootlessNetworkCmd: 'pasta',
      security: {
        apparmorEnabled: false,
        capabilities: 'CAP_CHOWN,CAP_DAC_OVERRIDE,CAP_FOWNER',
        rootless: true,
        seccompEnabled: true,
        seccompProfilePath: '/usr/share/containers/seccomp.json',
        selinuxEnabled: false,
      },
      serviceIsRemote: false,
      swapFree: 0,
      swapTotal: 0,
    },
    store: {
      graphDriverName: 'overlay',
      graphRoot: '/var/lib/leanflow-podman/storage',
      runRoot: '/run/leanflow-podman/containers',
    },
    version: { APIVersion: '5.7.0', Version: '5.7.0', OsArch: 'linux/amd64' },
  }
  change(info)
  return JSON.stringify(info)
}

const resources = (memory = '4g', swap = memory) => [
  '--cpus',
  '2',
  '--memory',
  memory,
  '--memory-swap',
  swap,
  '--pids-limit',
  '512',
]

function workerArgs({
  user = '1001:1001',
  kernel = false,
  security = [],
  extra = [],
  image = imageId,
} = {}) {
  return [
    'run',
    '--rm',
    '-i',
    '--init',
    '--name',
    'lemex-web-fixture-worker',
    '--label',
    'lemex-web.scope=server',
    ...(user ? ['--user', user] : []),
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...resources(kernel ? '12g' : '4g'),
    '--network',
    'none',
    ...(kernel
      ? [
          '--mount',
          'type=bind,src=/data/homes/a/kernel-check-tmp,dst=/tmp',
          '--ulimit',
          'fsize=1048576:1048576',
        ]
      : ['--tmpfs', '/tmp:rw,nosuid,size=1g']),
    '--workdir',
    '/workspace',
    '--mount',
    'type=bind,src=/data/projects/p,dst=/workspace,readonly',
    '--mount',
    'type=bind,src=/data/projects/p/.lake,dst=/workspace/.lake',
    '--env',
    'HOME=/home/worker',
    '--env',
    'LEAN_NUM_THREADS',
    ...(kernel
      ? [
          '--security-opt',
          `seccomp=${seccomp}`,
          '--security-opt',
          'systempaths=unconfined',
          '--tmpfs',
          '/run/user:rw,nosuid,noexec,size=16m,mode=1777',
        ]
      : []),
    ...security.flatMap((value) => ['--security-opt', value]),
    ...extra,
    image,
    'lake',
    'check',
    '--flag-for-lake',
  ]
}

const values = (args, option) =>
  args.flatMap((value, index) => (value === option ? [args[index + 1]] : []))

function without(args, ...removed) {
  const result = [...args]
  for (const value of removed) result.splice(result.indexOf(value), 1)
  return result
}

const rejected = (action, pattern) =>
  assert.throws(action, (error) => {
    assert.match(error.message, pattern)
    assert.equal(error.engineUnsupported, true)
    assert.equal(error.status, 503)
    return true
  })

test('Docker arguments, information and environment pass through unchanged', () => {
  const engine = new ContainerEngine()
  assert.equal(engine.kind, 'docker')
  assert.equal(engine.executable, 'docker')
  for (const args of [
    workerArgs({ kernel: true }),
    ['run', '--privileged', 'lemex-web-worker:local'],
    ['rm', '-f', 'lemex-web-fixture-worker'],
    ['info', '--format', '{{json .SecurityOptions}}'],
  ])
    assert.equal(engine.args(args), args)
  const base = { PATH: '/usr/bin', XDG_CONFIG_HOME: '/home/person/.config' }
  assert.equal(engine.environment(base), base)
  assert.deepEqual(engine.normalizeInfo('{"MemoryLimit":true,"Extra":1}'), {
    MemoryLimit: true,
    Extra: 1,
  })
  assert.throws(() => engine.normalizeInfo('not json'), SyntaxError)
  assert.equal(engine.profile, null)
  for (const key of ['XDG_RUNTIME_DIR', 'CONTAINERS_CONF', 'DOCKER_CONFIG'])
    assert.equal(engine.reservesEnvironment(key), false)
})

test('rootless cgroup v2 Podman information normalizes limits, security and identity', () => {
  assert.deepEqual(normalizePodmanInfo(podmanInfo()), {
    ServerVersion: '5.7.0',
    MemTotal: 32 * gib,
    MemoryLimit: true,
    SwapLimit: true,
    SecurityOptions: ['name=seccomp', 'name=rootless'],
    CgroupVersion: 'v2',
    CgroupManager: 'systemd',
    CgroupControllers: ['cpu', 'io', 'memory', 'pids'],
    Rootless: true,
    User: '1001:1001',
  })
  const system = normalizePodmanInfo(
    podmanInfo((info) => {
      info.host.security.rootless = false
      info.host.security.apparmorEnabled = true
      info.host.security.selinuxEnabled = true
      info.host.cgroupManager = 'cgroupfs'
      delete info.host.idMappings
    }),
    { hostAppArmor: true },
  )
  assert.deepEqual(system.SecurityOptions, [
    'name=seccomp',
    'name=apparmor',
    'name=selinux',
  ])
  assert.equal(system.User, null)
  const engine = new ContainerEngine({
    kind: 'podman',
    hostAppArmor: false,
    user: '1001:1001',
  })
  engine.normalizeInfo(podmanInfo())
  assert.deepEqual(engine.profile, rootless)
})

test('Podman information without delegated controllers or with malformed fields is rejected', () => {
  const cases = [
    [(i) => (i.host.cgroupControllers = ['memory', 'pids']), /cpu cgroup/],
    [(i) => (i.host.cgroupControllers = ['cpu']), /memory, pids cgroup/],
    [(i) => (i.host.cgroupControllers = []), /cpu, memory, pids cgroup/],
    [(i) => delete i.host.cgroupControllers, /cgroup controllers/],
    [(i) => (i.host.cgroupControllers = ['cpu', 7]), /cgroup controllers/],
    [(i) => (i.host.cgroupVersion = 'v1'), /cgroup v2/],
    [(i) => (i.host.cgroupManager = 'cgroupfs'), /systemd cgroup/],
    [(i) => (i.host.security.seccompEnabled = false), /seccomp/],
    [(i) => (i.host.serviceIsRemote = true), /local Podman/],
    [(i) => delete i.host.serviceIsRemote, /local Podman/],
    [(i) => (i.version.Version = '4.9.3'), /Podman 5/],
    [(i) => delete i.version.Version, /Podman 5/],
    [(i) => (i.host.memTotal = 0), /host memory/],
    [(i) => (i.host.memTotal = String(32 * gib)), /host memory/],
    [(i) => (i.host.memTotal = 1.5), /host memory/],
    [(i) => delete i.host.security.rootless, /security configuration/],
    [(i) => delete i.host.security, /incomplete/],
    [(i) => delete i.host.idMappings, /subuid/],
    [(i) => i.host.idMappings.uidmap.splice(1), /subuid/],
    [(i) => (i.host.idMappings.gidmap[0].size = 65536), /subuid/],
    [(i) => (i.host.idMappings.uidmap[0].host_id = 0), /subuid/],
    [(i) => (i.host.idMappings.uidmap[1].size = -1), /subuid/],
  ]
  for (const [change, pattern] of cases)
    rejected(() => normalizePodmanInfo(podmanInfo(change)), pattern)
  for (const stdout of ['not json', '[]', 'null', '{"host":{}}', ''])
    rejected(() => normalizePodmanInfo(stdout), /unreadable|incomplete/)
  // Rootless Podman cannot apply AppArmor, so it cannot replace Docker's
  // AppArmor confinement on an AppArmor host.
  rejected(
    () => normalizePodmanInfo(podmanInfo(), { hostAppArmor: true }),
    /AppArmor/,
  )
  const engine = new ContainerEngine({ kind: 'podman', hostAppArmor: false })
  engine.normalizeInfo(podmanInfo())
  assert.notEqual(engine.profile, null)
  rejected(
    () =>
      engine.normalizeInfo(
        podmanInfo((i) => (i.host.cgroupControllers = ['memory'])),
      ),
    /cpu, pids cgroup/,
  )
  assert.equal(engine.profile, null)
  rejected(() => engine.args(workerArgs()), /not been verified/)
})

test('rootless keep-id keeps the non-root service account and its bind ownership', () => {
  const args = translatePodmanRun(workerArgs(), rootless)
  assert.deepEqual(args.slice(0, 2), ['run', '--userns=keep-id'])
  assert.deepEqual(values(args, '--user'), ['1001:1001'])
  assert.deepEqual(values(args, '--mount'), [
    'type=bind,src=/data/projects/p,dst=/workspace,readonly',
    'type=bind,src=/data/projects/p/.lake,dst=/workspace/.lake',
  ])
  // Runs without an explicit user still run as the service account.
  const provenance = translatePodmanRun(workerArgs({ user: null }), rootless)
  assert.deepEqual(values(provenance, '--user'), ['1001:1001'])
  rejected(
    () => translatePodmanRun(workerArgs({ user: '1002:1001' }), rootless),
    /service account/,
  )
  for (const user of ['0:0', '0:1001', '00:0', 'worker', '1001'])
    rejected(() => translatePodmanRun(workerArgs({ user }), rootless), /--user/)
  rejected(
    () =>
      translatePodmanRun(workerArgs({ extra: ['--userns=host'] }), rootless),
    /--userns/,
  )
  const system = translatePodmanRun(workerArgs(), rootful)
  assert(!system.includes('--userns=keep-id'))
  assert.deepEqual(values(system, '--user'), ['1001:1001'])
  const engine = new ContainerEngine({
    kind: 'podman',
    hostAppArmor: false,
    user: '1002:1002',
  })
  rejected(() => engine.normalizeInfo(podmanInfo()), /service account/)
  assert.equal(engine.profile, null)
})

test('kernel workers get the explicit Podman unmask while ordinary workers keep their masks', () => {
  const ordinary = translatePodmanRun(workerArgs(), rootless)
  const kernel = translatePodmanRun(workerArgs({ kernel: true }), rootless)
  assert.deepEqual(values(ordinary, '--security-opt'), ['no-new-privileges'])
  assert.deepEqual(values(kernel, '--security-opt'), [
    'no-new-privileges',
    `seccomp=${seccomp}`,
    'unmask=ALL',
  ])
  for (const args of [ordinary, kernel]) {
    assert(!args.includes('systempaths=unconfined'))
    assert.equal(
      args[args.indexOf('--read-only') + 1],
      '--read-only-tmpfs=false',
    )
    assert.deepEqual(values(args, '--cap-drop'), ['ALL'])
    assert.deepEqual(values(args, '--network'), ['none'])
    assert.deepEqual(values(args, '--pids-limit'), ['512'])
    assert.deepEqual(values(args, '--cpus'), ['2'])
    assert.deepEqual(values(args, '--memory'), values(args, '--memory-swap'))
    for (const pin of [
      '--cgroups=enabled',
      '--pull=never',
      '--http-proxy=false',
      '--env-host=false',
    ])
      assert(args.includes(pin), pin)
    assert.deepEqual(args.slice(-4), [
      imageId,
      'lake',
      'check',
      '--flag-for-lake',
    ])
  }
  assert.deepEqual(values(kernel, '--memory'), ['12g'])
  assert.deepEqual(values(kernel, '--ulimit'), ['fsize=1048576:1048576'])
  // AppArmor profiles are kept when Podman can apply them and never dropped.
  const apparmor = ['apparmor=leanflow-kernel-check']
  rejected(
    () =>
      translatePodmanRun(
        workerArgs({ kernel: true, security: apparmor }),
        rootless,
      ),
    /AppArmor/,
  )
  const confined = { ...rootful, apparmor: true }
  assert(
    values(
      translatePodmanRun(
        workerArgs({ kernel: true, security: apparmor }),
        confined,
      ),
      '--security-opt',
    ).includes(apparmor[0]),
  )
  rejected(
    () => translatePodmanRun(workerArgs({ kernel: true }), confined),
    /read-only root/,
  )
  const unfiltered = workerArgs({ kernel: true })
  unfiltered.splice(unfiltered.indexOf(`seccomp=${seccomp}`) - 1, 2)
  rejected(
    () => translatePodmanRun(unfiltered, rootless),
    /seccomp and resource limits/,
  )
  const unsafeSeccomp = workerArgs({ security: ['seccomp=unconfined'] })
  rejected(() => translatePodmanRun(unsafeSeccomp, rootless), /seccomp/)
})

test('Podman runs reject missing mandatory controls and options it does not understand', () => {
  const args = workerArgs()
  const removeOption = (option) => {
    const result = [...args]
    result.splice(result.indexOf(option), 2)
    return result
  }
  for (const changed of [
    without(args, '--read-only'),
    removeOption('--cap-drop'),
    removeOption('--cpus'),
    removeOption('--memory-swap'),
    removeOption('--pids-limit'),
    without(args, '--security-opt', 'no-new-privileges'),
    [
      ...args.slice(0, args.indexOf('--cpus')),
      ...resources('4g', '8g'),
      ...args.slice(args.indexOf('--pids-limit') + 2),
    ],
  ])
    rejected(() => translatePodmanRun(changed, rootless), /read-only root/)
  for (const [extra, pattern] of [
    [['--privileged'], /--privileged/],
    [['--cap-add', 'SYS_ADMIN'], /--cap-add/],
    [['--network', 'host'], /--network/],
    [['--security-opt', 'label=disable'], /--security-opt label/],
    [['--security-opt', 'systempaths=open'], /--security-opt systempaths/],
    [['--mount', 'type=volume,src=data,dst=/data'], /--mount/],
    [['--mount', 'type=bind,src=/a,dst=/b,bind-propagation=shared'], /--mount/],
    [['--tmpfs', '/scratch:rw,exec'], /--tmpfs/],
    [['--ulimit', 'nofile=1:1'], /--ulimit/],
    [['--log-driver', 'journald'], /--log-driver/],
    [['--cap-drop', 'NET_RAW'], /--cap-drop/],
  ])
    rejected(() => translatePodmanRun(workerArgs({ extra }), rootless), pattern)
  rejected(() => translatePodmanRun(['run', '--rm'], rootless), /--rm|pinned/)
})

test('image identities normalize to one sha256 form and Podman runs require that pin', () => {
  assert.equal(normalizeImageId(`${hex}\n`, 'podman'), imageId)
  assert.equal(normalizeImageId(`${imageId}\n`, 'podman'), imageId)
  assert.equal(normalizeImageId(`${imageId}\n`, 'docker'), imageId)
  rejected(() => normalizeImageId(hex, 'docker'), /Docker reported an invalid/)
  for (const value of [
    hex.toUpperCase(),
    hex.slice(1),
    `${imageId}0`,
    `sha512:${hex}`,
    `sha256:sha256:${hex}`,
    'lemex-web-worker:local',
    `${hex}\n${hex}`,
    `${imageId} extra`,
    '',
    null,
  ])
    for (const kind of ['docker', 'podman'])
      rejected(() => normalizeImageId(value, kind), /invalid image identity/)
  const engine = new ContainerEngine({ kind: 'podman' })
  assert.equal(engine.normalizeImageId(hex), imageId)
  for (const image of [hex, 'lemex-web-worker:local', `docker.io/x@${imageId}`])
    rejected(
      () => translatePodmanRun(workerArgs({ image }), rootless),
      /pinned image identity/,
    )
})

test('Podman host commands keep the Docker lifecycle and reject unknown commands', () => {
  assert.deepEqual(translatePodmanArgs(['rm', '-f', 'a1', 'lemex-x'], null), [
    'rm',
    '-f',
    '-t',
    '0',
    'a1',
    'lemex-x',
  ])
  for (const args of [
    ['info', '--format', '{{json .}}'],
    ['image', 'inspect', '--format', '{{.Id}}', 'lemex-web-worker:local'],
    ['ps', '-q'],
    ['ps', '-aq', '--filter', 'label=a=b', '--filter', 'label=c=d'],
    ['inspect', '--format', '{{json .Mounts}}', 'abc123', 'def456'],
  ])
    assert.equal(translatePodmanArgs(args, null), args)
  for (const args of [
    ['info', '--format', '{{json .SecurityOptions}}'],
    ['rm', 'lemex-x'],
    ['rm', '-f'],
    ['rm', '-f', '--volumes'],
    ['ps', '-a', '--format', 'json'],
    ['inspect', 'abc123'],
    ['exec', 'abc123', 'sh'],
    ['system', 'prune', '-f'],
    [],
  ])
    rejected(() => translatePodmanArgs(args, rootless), /container option/)
  rejected(() => translatePodmanArgs(workerArgs(), null), /not been verified/)
})

test('engine environment relocates Podman storage without leaking personal settings or values', () => {
  const env = {
    HOME: '/var/lib/leanflow-podman/home',
    XDG_RUNTIME_DIR: '/run/leanflow-podman',
    CONTAINERS_STORAGE_CONF: '/etc/leanflow/storage.conf',
  }
  const engine = new ContainerEngine({ kind: 'podman', env })
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/person',
    XDG_CONFIG_HOME: '/home/person/.config',
    XDG_DATA_HOME: '/home/person/.local/share',
    CONTAINERS_CONF: '/home/person/containers.conf',
    WORKER_VALUE: 'kept',
  }
  assert.deepEqual(engine.environment(base), {
    PATH: '/usr/bin',
    WORKER_VALUE: 'kept',
    ...env,
  })
  assert.equal(base.HOME, '/home/person')
  const runroot = new ContainerEngine({
    kind: 'podman',
    env: { XDG_RUNTIME_DIR: '/run/leanflow-podman' },
  })
  assert.equal(
    runroot.environment(base).XDG_CONFIG_HOME,
    '/home/person/.config',
  )
  for (const key of [
    'XDG_RUNTIME_DIR',
    'XDG_DATA_HOME',
    'CONTAINERS_CONF',
    'CONTAINERS_CONF_OVERRIDE',
    'CONTAINER_HOST',
    'PODMAN_USERNS',
    'REGISTRY_AUTH_FILE',
  ])
    assert(engine.reservesEnvironment(key), key)
  for (const key of ['LEMEX_API_KEY', 'TMPDIR', 'GIT_TERMINAL_PROMPT'])
    assert(!engine.reservesEnvironment(key), key)
  const secret = 'private-value-must-not-appear'
  for (const [setting, pattern] of [
    [{ REGISTRY_AUTH_FILE: `/${secret}` }, /Unsupported Podman environment/],
    [{ DOCKER_CONFIG: `/${secret}` }, /Unsupported Podman environment/],
    [{ HOME: `relative/${secret}` }, /normalized absolute path/],
    [{ HOME: `/home/${secret}/../x` }, /normalized absolute path/],
    [{ HOME: `/home/x\n${secret}` }, /normalized absolute path/],
    [{ HOME: 42 }, /normalized absolute path/],
  ])
    assert.throws(
      () => new ContainerEngine({ kind: 'podman', env: setting }),
      (error) => {
        assert.match(error.message, pattern)
        assert(!error.message.includes(secret))
        return true
      },
    )
  assert.throws(
    () => new ContainerEngine({ kind: 'podman', env: ['HOME'] }),
    /must be an object/,
  )
  const docker = new ContainerEngine({
    env: { DOCKER_CONFIG: '/etc/leanflow/docker' },
  })
  assert.equal(
    docker.environment({ PATH: '/usr/bin' }).DOCKER_CONFIG,
    '/etc/leanflow/docker',
  )
  assert(docker.reservesEnvironment('DOCKER_CONFIG'))
  assert.throws(
    () => new ContainerEngine({ env: { HOME: '/srv/docker' } }),
    /Unsupported Docker environment setting HOME/,
  )
})

test('engine kinds and executables are explicit', () => {
  assert.equal(new ContainerEngine({ kind: 'podman' }).executable, 'podman')
  assert.equal(
    new ContainerEngine({ kind: 'podman', executable: '/opt/podman' })
      .executable,
    '/opt/podman',
  )
  assert.throws(
    () => new ContainerEngine({ kind: 'containerd' }),
    /docker or podman/,
  )
  for (const executable of ['', 'dock\0er', 42])
    assert.throws(
      () => new ContainerEngine({ executable }),
      /executable must be a nonempty path/,
    )
})

test('the host AppArmor probe fails closed when its state is unreadable', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-apparmor-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const enabled = path.join(directory, 'enabled')
  await fs.writeFile(enabled, 'Y\n')
  assert.equal(hostAppArmorEnabled(enabled), true)
  await fs.writeFile(enabled, 'N\n')
  assert.equal(hostAppArmorEnabled(enabled), false)
  assert.equal(hostAppArmorEnabled(path.join(directory, 'missing')), false)
  assert.equal(hostAppArmorEnabled(path.join(enabled, 'below-file')), false)
  assert.equal(hostAppArmorEnabled(directory), true)
})
