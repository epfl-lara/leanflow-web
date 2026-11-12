import fs from 'node:fs'
import path from 'node:path'

export const containerEngineKinds = Object.freeze(['docker', 'podman'])

const labels = { docker: 'Docker', podman: 'Podman' }
// Operators may relocate engine configuration and storage, never credentials.
const configurationKeys = {
  docker: ['DOCKER_CONFIG'],
  podman: [
    'HOME',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'CONTAINERS_CONF',
    'CONTAINERS_STORAGE_CONF',
  ],
}
// These follow HOME, so a dedicated HOME must not inherit personal values.
const homeDerivedKeys = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CONTAINERS_CONF',
  'CONTAINERS_STORAGE_CONF',
]
const requiredControllers = ['cpu', 'memory', 'pids']
const imageIds = {
  docker: /^sha256:([a-f0-9]{64})$/,
  podman: /^(?:sha256:)?([a-f0-9]{64})$/,
}
const runSwitches = new Set(['--rm', '-i', '--init', '--read-only'])
const runOptions = new Set([
  '--name',
  '--label',
  '--user',
  '--cpus',
  '--memory',
  '--memory-swap',
  '--pids-limit',
  '--cgroup-parent',
  '--network',
  '--mount',
  '--ulimit',
  '--tmpfs',
  '--workdir',
  '--env',
  '--log-driver',
  '--security-opt',
  '--cap-drop',
])
const resourceOptions = ['--cpus', '--memory', '--memory-swap', '--pids-limit']
const tmpfsOption =
  /^(?:rw|nosuid|nodev|noexec|(?:size|mode|uid|gid)=[0-9]+[kmg]?)$/
const memorySize = /^[1-9][0-9]*[bkmg]?$/i
const identifier = /^[A-Za-z0-9][\w.-]*$/

function unsupported(message) {
  return Object.assign(new Error(message), {
    status: 503,
    engineUnsupported: true,
  })
}

function unsupportedOption(option) {
  return unsupported(
    `This worker request uses the ${option} container option, which LeanFlow does not support on Podman. Ask the server administrator to check the worker engine.`,
  )
}

const serviceAccountMismatch = () =>
  unsupported(
    'Rootless Podman workers must run as the LeanFlow service account. Ask the server administrator to run LeanFlow and Podman as the same account.',
  )

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null
}

export function hostAppArmorEnabled(
  filename = '/sys/module/apparmor/parameters/enabled',
) {
  try {
    return fs.readFileSync(filename, 'utf8').trim() === 'Y'
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    // An unreadable LSM state must not be mistaken for a host without AppArmor.
    return true
  }
}

export function normalizeImageId(value, kind = 'docker') {
  const match =
    typeof value === 'string' ? imageIds[kind]?.exec(value.trim()) : null
  // Runtime adds the rebuild instruction for its worker and TeX images.
  if (!match)
    throw unsupported(
      `${labels[kind] || 'The container engine'} reported an invalid image identity`,
    )
  return `sha256:${match[1]}`
}

export function engineEnvironment(kind, env = {}) {
  if (!record(env))
    throw new Error('Container engine environment must be an object.')
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (!configurationKeys[kind].includes(key))
      throw new Error(
        `Unsupported ${labels[kind]} environment setting ${key}. Use ${configurationKeys[kind].join(', ')}.`,
      )
    // Report only the setting name; values may reveal private host layout.
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      !path.posix.isAbsolute(value) ||
      path.posix.normalize(value) !== value ||
      [...value].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error(
        `${labels[kind]} environment setting ${key} must be a normalized absolute path.`,
      )
    result[key] = value
  }
  return Object.freeze(result)
}

export function engineProcessEnvironment(kind, env, base = process.env) {
  if (!Object.keys(env).length) return base
  const result = { ...base }
  if (kind === 'podman' && env.HOME)
    for (const key of homeDerivedKeys) delete result[key]
  return Object.assign(result, env)
}

function mappedHostId(list) {
  if (
    !Array.isArray(list) ||
    list.some(
      (entry) =>
        !record(entry) ||
        ![entry.container_id, entry.host_id, entry.size].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        entry.size === 0,
    )
  )
    return null
  const own = list.find((entry) => entry.container_id === 0)
  // keep-id maps the service account to itself and other IDs to a subordinate
  // range, so both must be present.
  return own?.size === 1 && list.some((entry) => entry !== own)
    ? own.host_id
    : null
}

export function normalizePodmanInfo(stdout, { hostAppArmor = false } = {}) {
  let info
  try {
    info = JSON.parse(stdout)
  } catch {
    throw unsupported(
      'Podman returned unreadable engine information. Ask the server administrator to check Podman.',
    )
  }
  const host = record(record(info)?.host)
  const security = record(host?.security)
  const version = record(record(info)?.version)
  if (!host || !security || !version)
    throw unsupported(
      'Podman returned incomplete engine information. Ask the server administrator to check Podman.',
    )
  const major = /^([0-9]+)\.[0-9]+\.[0-9]+/.exec(version.Version)
  if (!major || Number(major[1]) < 5)
    throw unsupported(
      'LeanFlow workers require Podman 5 or newer. Ask the server administrator to update Podman.',
    )
  if (host.serviceIsRemote !== false)
    throw unsupported(
      'LeanFlow workers require a local Podman engine, not a remote connection. Ask the server administrator to check the Podman configuration.',
    )
  if (
    typeof security.rootless !== 'boolean' ||
    typeof security.apparmorEnabled !== 'boolean'
  )
    throw unsupported(
      'Podman did not report its security configuration. Ask the server administrator to check Podman.',
    )
  if (security.seccompEnabled !== true)
    throw unsupported(
      'Podman must apply seccomp filters before workers can start. Ask the server administrator to enable seccomp.',
    )
  if (hostAppArmor && !security.apparmorEnabled)
    throw unsupported(
      'This host uses AppArmor, but Podman cannot apply AppArmor profiles to workers. Rootless Podman does not apply them. Ask the server administrator to review the worker sandbox for this host.',
    )
  if (host.cgroupVersion !== 'v2')
    throw unsupported(
      'Podman workers require cgroup v2 resource limits. Ask the server administrator to enable cgroup v2.',
    )
  const controllers = host.cgroupControllers
  if (
    !Array.isArray(controllers) ||
    controllers.some((value) => typeof value !== 'string')
  )
    throw unsupported(
      'Podman did not report its cgroup controllers. Ask the server administrator to check cgroup delegation.',
    )
  const missing = requiredControllers.filter(
    (controller) => !controllers.includes(controller),
  )
  if (missing.length)
    throw unsupported(
      `Podman must have the ${missing.join(', ')} cgroup controllers before workers can start. Ask the server administrator to delegate them to the LeanFlow service account.`,
    )
  if (security.rootless && host.cgroupManager !== 'systemd')
    throw unsupported(
      'Rootless Podman workers require the systemd cgroup manager for resource limits. Ask the server administrator to configure it.',
    )
  if (!Number.isSafeInteger(host.memTotal) || host.memTotal <= 0)
    throw unsupported(
      'Podman did not report host memory. Ask the server administrator to check Podman.',
    )
  let user = null
  if (security.rootless) {
    const uid = mappedHostId(host.idMappings?.uidmap)
    const gid = mappedHostId(host.idMappings?.gidmap)
    if (!uid || gid === null)
      throw unsupported(
        'Rootless Podman must map the LeanFlow service account and a subordinate ID range. Ask the server administrator to configure /etc/subuid and /etc/subgid.',
      )
    user = `${uid}:${gid}`
  }
  return {
    ServerVersion: version.Version,
    MemTotal: host.memTotal,
    // These follow the reported cgroup v2 controllers. Per-node enforcement
    // is certified separately.
    MemoryLimit: true,
    SwapLimit: true,
    SecurityOptions: [
      'name=seccomp',
      ...(security.apparmorEnabled ? ['name=apparmor'] : []),
      ...(security.selinuxEnabled === true ? ['name=selinux'] : []),
      ...(security.rootless ? ['name=rootless'] : []),
    ],
    CgroupVersion: host.cgroupVersion,
    CgroupManager: host.cgroupManager,
    CgroupControllers: [...controllers],
    Rootless: security.rootless,
    User: user,
  }
}

function podmanSecurityOption(value, profile, found) {
  if (value === 'no-new-privileges') {
    found.noNewPrivileges = true
    return value
  }
  if (value === 'systempaths=unconfined') {
    // Podman's explicit equivalent removes both masked and read-only paths.
    found.unmasked = true
    return 'unmask=ALL'
  }
  if (/^seccomp=\/[^\0]+$/.test(value)) {
    found.seccomp = true
    return value
  }
  if (/^apparmor=[A-Za-z0-9._-]+$/.test(value)) {
    if (!profile.apparmor)
      throw unsupported(
        'Podman cannot apply the requested worker AppArmor profile. Ask the server administrator to review the worker sandbox.',
      )
    found.apparmor = true
    return value
  }
  throw unsupportedOption(`--security-opt ${value.split('=')[0]}`)
}

function validRunOption(option, value) {
  switch (option) {
    case '--user': {
      const ids = /^([0-9]+):[0-9]+$/.exec(value)
      return Boolean(ids) && Number(ids[1]) !== 0
    }
    case '--cpus':
      return /^[0-9]+(?:\.[0-9]+)?$/.test(value) && Number(value) > 0
    case '--memory':
    case '--memory-swap':
      return memorySize.test(value)
    case '--pids-limit':
      return /^[1-9][0-9]*$/.test(value)
    case '--cgroup-parent':
      return /^[A-Za-z0-9_.@-]+\.slice$/.test(value)
    case '--network':
      return value === 'none' || value === 'bridge'
    case '--ulimit':
      return /^fsize=[0-9]+:[0-9]+$/.test(value)
    case '--log-driver':
      return value === 'none'
    case '--cap-drop':
      return value === 'ALL'
    case '--workdir':
      return path.posix.isAbsolute(value)
    case '--tmpfs': {
      const [target, options = ''] = value.split(':')
      return (
        path.posix.isAbsolute(target) &&
        options.split(',').every((option) => tmpfsOption.test(option))
      )
    }
    case '--mount': {
      const [type, source, destination, ...options] = value.split(',')
      return (
        type === 'type=bind' &&
        /^src=\//.test(source || '') &&
        /^dst=\//.test(destination || '') &&
        options.every((option) => option === 'readonly')
      )
    }
    default:
      return true
  }
}

export function translatePodmanRun(args, profile) {
  if (!profile)
    throw unsupported(
      'Podman has not been verified for workers yet. Ask the server administrator to restart LeanFlow.',
    )
  const output = []
  const found = {}
  let index = 1
  for (; index < args.length && args[index].startsWith('-'); index++) {
    const option = args[index]
    if (runSwitches.has(option)) {
      output.push(option)
      if (option === '--read-only') {
        // Podman otherwise adds writable /run, /tmp and /var/tmp mounts.
        output.push('--read-only-tmpfs=false')
        found.readOnly = true
      }
      continue
    }
    if (!runOptions.has(option) || index + 1 >= args.length)
      throw unsupportedOption(option.split('=')[0])
    const value = args[++index]
    if (option === '--security-opt') {
      output.push(option, podmanSecurityOption(value, profile, found))
      continue
    }
    if (!validRunOption(option, value)) throw unsupportedOption(option)
    // Any other user would own bind mounts through a subordinate ID.
    if (option === '--user' && profile.user && value !== profile.user)
      throw serviceAccountMismatch()
    if (option === '--user') found.user = true
    if (option === '--cap-drop') found.capabilities = true
    if (resourceOptions.includes(option)) found[option] = value.toLowerCase()
    output.push(option, value)
  }
  const image = args[index]
  if (image === undefined || !imageIds.docker.test(image))
    throw unsupported(
      'Podman workers must use a pinned image identity. Ask the server administrator to restart LeanFlow after rebuilding the worker image.',
    )
  if (
    !found.readOnly ||
    !found.capabilities ||
    !found.noNewPrivileges ||
    resourceOptions.some((option) => !found[option]) ||
    found['--memory-swap'] !== found['--memory'] ||
    (found.unmasked &&
      (!found.seccomp || (profile.apparmor && !found.apparmor)))
  )
    throw unsupported(
      'Podman workers must keep a read-only root, dropped capabilities, no-new-privileges, seccomp and resource limits. Ask the server administrator to check the worker engine.',
    )
  return [
    'run',
    ...(profile.rootless ? ['--userns=keep-id'] : []),
    ...(profile.rootless && !found.user ? ['--user', profile.user] : []),
    // Pin settings that containers.conf could otherwise change silently.
    '--cgroups=enabled',
    '--pull=never',
    '--http-proxy=false',
    '--env-host=false',
    ...output,
    image,
    ...args.slice(index + 1),
  ]
}

function validPsOptions(options) {
  for (let index = 0; index < options.length; index++) {
    if (options[index] === '-q' || options[index] === '-aq') continue
    if (options[index] !== '--filter') return false
    if (!/^label=/.test(options[++index] || '')) return false
  }
  return true
}

const identifiers = (values) =>
  values.length > 0 && values.every((value) => identifier.test(value))

export function translatePodmanArgs(args, profile) {
  const [command, ...rest] = args
  if (command === 'run') return translatePodmanRun(args, profile)
  if (command === 'rm' && rest[0] === '-f' && identifiers(rest.slice(1)))
    // Docker kills immediately; Podman would otherwise wait 10 seconds.
    return ['rm', '-f', '-t', '0', ...rest.slice(1)]
  if (
    (command === 'info' &&
      rest.length === 2 &&
      rest[0] === '--format' &&
      rest[1] === '{{json .}}') ||
    (command === 'image' &&
      rest.length === 4 &&
      rest[0] === 'inspect' &&
      rest[1] === '--format' &&
      rest[2] === '{{.Id}}') ||
    (command === 'ps' && validPsOptions(rest)) ||
    (command === 'inspect' &&
      rest[0] === '--format' &&
      identifiers(rest.slice(2)))
  )
    return args
  throw unsupportedOption(`${command} command`)
}

export class ContainerEngine {
  #executable

  constructor({
    kind = 'docker',
    executable,
    env = {},
    hostAppArmor,
    user,
  } = {}) {
    if (!containerEngineKinds.includes(kind))
      throw new Error('Unsupported container engine. Choose docker or podman.')
    this.kind = kind
    this.label = labels[kind]
    this.executable = executable ?? kind
    this.env = engineEnvironment(kind, env)
    this.hostAppArmor = hostAppArmor
    this.user = user
    this.profile = null
  }

  get executable() {
    return this.#executable
  }

  set executable(value) {
    if (typeof value !== 'string' || !value || value.includes('\0'))
      throw new Error('Container engine executable must be a nonempty path.')
    this.#executable = value
  }

  args(args) {
    return this.kind === 'docker'
      ? args
      : translatePodmanArgs(args, this.profile)
  }

  environment(base = process.env) {
    return engineProcessEnvironment(this.kind, this.env, base)
  }

  reservesEnvironment(key) {
    if (Object.hasOwn(this.env, key)) return true
    return (
      this.kind === 'podman' &&
      (configurationKeys.podman.includes(key) ||
        key === 'REGISTRY_AUTH_FILE' ||
        /^(?:CONTAINERS?|PODMAN)_/.test(key))
    )
  }

  normalizeInfo(stdout) {
    if (this.kind === 'docker') return JSON.parse(stdout)
    this.profile = null
    const info = normalizePodmanInfo(stdout, {
      hostAppArmor: this.hostAppArmor ?? hostAppArmorEnabled(),
    })
    if (info.Rootless && this.user !== undefined && info.User !== this.user)
      throw serviceAccountMismatch()
    this.profile = {
      rootless: info.Rootless,
      user: info.User,
      apparmor: info.SecurityOptions.includes('name=apparmor'),
    }
    return info
  }

  normalizeImageId(stdout) {
    return normalizeImageId(stdout, this.kind)
  }
}
