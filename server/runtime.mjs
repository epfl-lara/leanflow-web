import {
  TemporaryWorkspaces,
  removeDisposableTree,
} from './temporary-workspaces.mjs'
import { spawn as spawnChild } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { PreparedPresetCache } from './prepared-presets.mjs'
import { fileURLToPath } from 'node:url'
import {
  SharedDependencyCache,
  configurationDigest,
  readDependencyConfiguration,
  sharedDependencyCacheSchema,
} from './shared-dependencies.mjs'

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const presetDefinitions = JSON.parse(
  fs.readFileSync(path.join(projectDir, 'server/presets.json'), 'utf8'),
)
const validToolchain =
  /^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/
const toolchainName = (value) =>
  value.replaceAll('/', '--').replaceAll(':', '---')
const forbiddenEnv = new Set([
  'HOME',
  'ELAN_HOME',
  'LEMEX_HOME',
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
])

function ensurePrivateDirectory(base, relative) {
  let directory = base
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    if (segment === '..' || segment === '.')
      throw new Error('Invalid managed directory')
    directory = path.join(directory, segment)
    try {
      const stat = fs.lstatSync(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(
          'A managed worker directory was replaced by a symlink or file',
        )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fs.mkdirSync(directory, { mode: 0o700 })
    }
  }
  return directory
}

function rejectSymlink(filename) {
  try {
    if (fs.lstatSync(filename).isSymbolicLink())
      throw new Error('A managed worker file was replaced by a symlink')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function writableLakeCache(root, { mountedPackages = false } = {}) {
  const cache = ensurePrivateDirectory(root, '.lake')
  // A writable alias of a source inode would bypass the read-only workspace
  // mount. Symlinks remain governed by the destination mount permissions; do
  // not follow them or inspect dependencies that receive a read-only mount.
  const pending = [cache]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (mountedPackages && directory === cache && entry.name === 'packages')
        continue
      const filename = path.join(directory, entry.name)
      const stat = fs.lstatSync(filename)
      if (stat.isDirectory()) pending.push(filename)
      else if (stat.isFile() && stat.nlink > 1)
        throw new Error('Writable Lake cache must not contain hardlinked files')
    }
  }
  return cache
}

const updateRegistryScript = String.raw`
import fcntl, json, os, sys, tempfile
filename = sys.argv[1]
lockfile = filename + '.lock'
fd = os.open(lockfile, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        with open(filename, encoding='utf-8') as stream:
            registry = json.load(stream)
    except FileNotFoundError:
        registry = {}
    if not isinstance(registry, dict):
        raise ValueError('Invalid runtime registry format')
    changes = json.load(sys.stdin)
    for key in changes.get('delete', []):
        registry.pop(key, None)
    registry.update(changes.get('set', {}))
    temp_fd, temporary = tempfile.mkstemp(prefix='.registry-', dir=os.path.dirname(filename))
    try:
        with os.fdopen(temp_fd, 'w', encoding='utf-8') as stream:
            json.dump(registry, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, filename)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps(registry))
finally:
    os.close(fd)
`

export class Runtime {
  dependencyPreparationReason(root) {
    try {
      const source = this.dependencyRoot(root)
      if (!this.#sharedSource(source)) return null
      const metadata = JSON.parse(
        fs.readFileSync(path.join(source, '.ready.json'), 'utf8'),
      )
      return metadata.schema === sharedDependencyCacheSchema
        ? null
        : 'This project uses an older dependency cache. Stop active checks and chats, then use Refresh setup to rebuild the pinned environment.'
    } catch (error) {
      if (error.status === 409)
        return 'The project configuration no longer matches its prepared dependencies. Use Refresh setup to check the updated environment.'
      if (error.code === 'ENOENT')
        return 'The prepared dependencies are unavailable. Use Refresh setup to rebuild the pinned environment.'
      throw error
    }
  }
  constructor({
    dataDir,
    image = process.env.LEMEX_WORKER_IMAGE || 'lemex-web-worker:local',
    maxConcurrent = 6,
    maxQueue = 24,
    cpus = 2,
    memory = '4g',
    pidsLimit = 512,
    docker = 'docker',
    hostToolchainDir = path.join(process.env.HOME || '', '.elan/toolchains'),
    scope = 'helper',
  } = {}) {
    if (!dataDir) throw new Error('Runtime requires an owned dataDir')
    this.dataDir = path.resolve(dataDir)
    this.runtimeDir = path.join(this.dataDir, 'runtime')
    this.image = image
    this.maxConcurrent = maxConcurrent
    this.maxQueue = maxQueue
    this.cpus = cpus
    this.memory = memory
    this.pidsLimit = pidsLimit
    this.docker = docker
    this.hostToolchainDir = hostToolchainDir
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(scope))
      throw new Error('Invalid runtime scope')
    this.scope = scope
    this.instance = null
    this.reaped = 0
    this.owner = randomUUID()
    this.children = new Set()
    this.toolchains = new Map()
    this.dependencies = new Map()
    this.dependencyRegistryStamp = null
    this.sharedCache = new SharedDependencyCache(this, (relative) =>
      ensurePrivateDirectory(this.runtimeDir, relative),
    )
    this.preparedPresets = new PreparedPresetCache(this, () =>
      ensurePrivateDirectory(this.runtimeDir, 'prepared-presets'),
    )
    this.dependencyWrites = Promise.resolve()
    this.installing = new Map()
    this.toolchainQueue = Promise.resolve()
    this.queue = []
    this.ready = false
    this.error = null
    this.temporaryWorkspaces = new TemporaryWorkspaces({
      directory: path.join(this.runtimeDir, 'temporary-workspaces'),
      allowedRoots: [
        path.join(this.runtimeDir, 'shared-dependency-stages'),
        path.join(this.dataDir, 'setup-repairs'),
      ],
      cleanup: (root) => this.#removeTemporaryWorkspace(root),
    })
    this.stopping = false
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    this.dataDir = await fsp.realpath(this.dataDir)
    this.runtimeDir = path.join(this.dataDir, 'runtime')
    this.temporaryWorkspaces.directory = path.join(
      this.runtimeDir,
      'temporary-workspaces',
    )
    this.temporaryWorkspaces.allowedRoots = [
      path.join(this.runtimeDir, 'shared-dependency-stages'),
      path.join(this.dataDir, 'setup-repairs'),
    ]
    this.lemexCommit = null
    this.lemexNativeBuildCommit = null
    await fsp.mkdir(this.runtimeDir, { recursive: true, mode: 0o700 })
    this.instance = createHash('sha256')
      .update(`${await fsp.realpath(this.dataDir)}\0${this.scope}`)
      .digest('hex')
    for (const directory of ['homes', 'elan/toolchains', 'templates'])
      await fsp.mkdir(path.join(this.runtimeDir, directory), {
        recursive: true,
        mode: 0o700,
      })
    try {
      const info = await this.#host(['info', '--format', '{{.ServerVersion}}'])
      if (info.code !== 0)
        throw new Error(info.stderr || 'Docker Engine is unavailable')
      if (this.scope === 'server') await this.#reapOrphans()
      const image = await this.#host([
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        this.image,
      ])
      if (info.code !== 0 || image.code !== 0)
        throw new Error(
          info.stderr || image.stderr || 'Docker worker image is unavailable',
        )
      this.imageId = image.stdout.trim()
      this.dockerVersion = info.stdout.trim()
      const native = await this.#host([
        'run',
        '--rm',
        '--label',
        `lemex-web.owner=${this.owner}`,
        '--label',
        `lemex-web.instance=${this.instance}`,
        '--label',
        `lemex-web.scope=${this.scope}`,
        '--read-only',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        this.imageId,
        '/usr/bin/cat',
        '/opt/lemex/lemex-install.json',
      ])
      if (native.code !== 0)
        throw new Error('Pinned worker image has no verified native provenance')
      const provenance = JSON.parse(native.stdout)
      this.lemexCommit =
        provenance.source_commit || provenance.native_build_commit || null
      this.lemexNativeBuildCommit = provenance.native_build_commit || null
      this.ready = true
      this.error = null
    } catch (error) {
      this.ready = false
      this.error = `Worker unavailable: ${error.message}. Run scripts/build-worker.sh.`
    }
    try {
      const registry = JSON.parse(
        await fsp.readFile(
          path.join(this.runtimeDir, 'toolchains.json'),
          'utf8',
        ),
      )
      for (const [toolchain, source] of Object.entries(registry)) {
        if (
          validToolchain.test(toolchain) &&
          fs.existsSync(path.join(source, 'bin/lean'))
        )
          this.toolchains.set(toolchain, source)
      }
    } catch {
      /* First startup has no registry. */
    }
    this.#reloadDependencies()
    if (this.ready) {
      try {
        const containers = await this.#host(['ps', '-q'])
        if (containers.code === 0) {
          const ids = containers.stdout.trim().split(/\s+/).filter(Boolean)
          const inspected = ids.length
            ? await this.#host([
                'inspect',
                '--format',
                '{{json .Mounts}}',
                ...ids,
              ])
            : { code: 0, stdout: '' }
          if (inspected.code === 0) {
            const mounts = inspected.stdout
              .trim()
              .split('\n')
              .filter(Boolean)
              .flatMap((line) => JSON.parse(line).map((mount) => mount.Source))
            await this.temporaryWorkspaces.sweep(mounts)
          }
        }
      } catch (error) {
        console.warn('Deferred startup workspace cleanup:', error.message)
      }
    }
    return this.info()
  }

  async claimTemporaryWorkspace(root) {
    await this.temporaryWorkspaces.claim(root)
  }

  async releaseTemporaryWorkspace(root) {
    await this.temporaryWorkspaces.release(root)
  }

  async #removeTemporaryWorkspace(root) {
    this.#reloadDependencies()
    if (
      [...this.dependencies].some(([target, source]) => {
        if (target === root || source !== root) return false
        try {
          return this.#root(target) === target
        } catch {
          return false
        }
      })
    )
      return false
    await this.#persistDependencies({ delete: [root] })
    this.dependencies.delete(root)
    await removeDisposableTree(root)
    const digest = createHash('sha256').update(root).digest('hex')
    await removeDisposableTree(path.join(this.runtimeDir, 'homes', digest))
    await fsp.rm(
      path.join(
        this.runtimeDir,
        'shared-dependency-bindings',
        digest + '.json',
      ),
      { force: true },
    )
    return true
  }

  #reloadDependencies() {
    const filename = path.join(this.runtimeDir, 'dependencies.json')
    const stamp = (stat) =>
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    let registry, loadedStamp
    try {
      if (
        stamp(fs.statSync(filename, { bigint: true })) ===
        this.dependencyRegistryStamp
      )
        return
      // Read and fingerprint the same file, even if another server atomically
      // replaces the registry during this lookup. Validate only the selected
      // binding at use, so filesystem changes never depend on this cache.
      const fd = fs.openSync(filename, 'r')
      try {
        loadedStamp = stamp(fs.fstatSync(fd, { bigint: true }))
        registry = JSON.parse(fs.readFileSync(fd, 'utf8'))
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.dependencies.clear()
        this.dependencyRegistryStamp = null
        return
      }
      throw error
    }
    if (!registry || typeof registry !== 'object' || Array.isArray(registry))
      throw new Error('Invalid runtime dependency registry')
    this.dependencies = new Map(
      Object.entries(registry).filter(
        ([target, source]) =>
          path.isAbsolute(target) &&
          typeof source === 'string' &&
          path.isAbsolute(source),
      ),
    )
    this.dependencyRegistryStamp = loadedStamp
  }

  #dependencySource(root) {
    const source = this.dependencies.get(root)
    if (source && this.#root(source) !== source)
      throw new Error(
        'Dependency source must be a real directory inside the owned data directory',
      )
    return source
  }

  dependencyRoot(root) {
    this.#reloadDependencies()
    const actual = this.#root(root)
    const source = this.#dependencySource(actual) || actual
    const directory = this.#dependencyPackages(source)
    if (!directory) return null
    try {
      return fs.readdirSync(directory).length ? source : null
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  #dependencyPackages(source) {
    // Worker-created symlinks must never expand a selected project's mount
    // to another owned project. Check each ancestor, including dangling links.
    let directory = source
    try {
      for (const segment of ['.lake', 'packages']) {
        directory = path.join(directory, segment)
        const stat = fs.lstatSync(directory)
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw new Error(
            'Dependency directories must be real directories inside the selected dependency project',
          )
      }
      if (fs.realpathSync(directory) !== directory)
        throw new Error(
          'Dependency mount escapes the selected dependency project',
        )
      return directory
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async inheritDependencies(sourceRoot, targetRoot) {
    const target = this.#root(targetRoot)
    const source = this.dependencyRoot(sourceRoot)
    if (!source) return null
    ensurePrivateDirectory(target, path.join('.lake', 'packages'))
    if (this.#sharedSource(source)) {
      const bindings = ensurePrivateDirectory(
        this.runtimeDir,
        'shared-dependency-bindings',
      )
      const filename = path.join(
        bindings,
        createHash('sha256').update(target).digest('hex') + '.json',
      )
      rejectSymlink(filename)
      await fsp.writeFile(
        filename,
        JSON.stringify({
          source,
          configuration: configurationDigest(
            readDependencyConfiguration(target),
          ),
        }),
        { mode: 0o600 },
      )
    }
    this.dependencies.set(target, source)
    await this.#persistDependencies({ set: { [target]: source } })
    return source
  }

  async clearInheritedDependencies(root, { force = false } = {}) {
    this.#reloadDependencies()
    const actual = this.#root(root)
    const source = this.dependencies.get(actual)
    if (!force && source !== actual && !this.#sharedSource(source)) return false
    this.dependencies.delete(actual)
    await this.#persistDependencies({ delete: [actual] })
    return true
  }

  #sharedSource(source) {
    return (
      typeof source === 'string' &&
      path.dirname(source) === path.join(this.runtimeDir, 'shared-dependencies')
    )
  }

  #dependencyArtifactCache(source) {
    if (this.#sharedSource(source))
      return path.join(source, '.dependency-lake-cache')
    const key = createHash('sha256').update(source).digest('hex')
    return path.join(this.runtimeDir, 'homes', key, '.cache/lake')
  }

  async prepareSharedDependencies(root, options) {
    this.#assertReady()
    this.#root(root)
    return this.sharedCache.prepare(options)
  }

  #checkSharedBinding(root, source) {
    if (!this.#sharedSource(source)) return
    const filename = path.join(
      this.runtimeDir,
      'shared-dependency-bindings',
      createHash('sha256').update(root).digest('hex') + '.json',
    )
    rejectSymlink(filename)
    const binding = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (
      binding.source !== source ||
      binding.configuration !==
        configurationDigest(readDependencyConfiguration(root))
    ) {
      throw Object.assign(
        new Error(
          'The project dependency configuration changed. Prepare the project again before running Lean.',
        ),
        { status: 409 },
      )
    }
  }

  async #persistDependencies(changes) {
    this.dependencyWrites = this.dependencyWrites
      .catch(() => {})
      .then(async () => {
        await this.#updateRegistry('dependencies.json', changes)
        this.dependencyRegistryStamp = null
        this.#reloadDependencies()
      })
    await this.dependencyWrites
  }

  #updateRegistry(filename, changes) {
    return new Promise((resolve, reject) => {
      const child = spawnChild(
        'python3',
        ['-c', updateRegistryScript, path.join(this.runtimeDir, filename)],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4000)
      })
      const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`Runtime registry update failed: ${stderr}`))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (error) {
          reject(error)
        }
      })
      child.stdin.end(JSON.stringify(changes))
    })
  }

  async #reapOrphans() {
    // The server holds its data-directory lease before calling init. Helpers
    // have a different stable instance label and are never selected here.
    const list = await this.#host([
      'ps',
      '-aq',
      '--filter',
      `label=lemex-web.instance=${this.instance}`,
      '--filter',
      'label=lemex-web.scope=server',
    ])
    if (list.code !== 0)
      throw new Error(`Cannot inspect prior server workers: ${list.stderr}`)
    const ids = list.stdout.trim().split(/\s+/).filter(Boolean)
    if (!ids.length) return
    const owners = await this.#host([
      'inspect',
      '--format',
      '{{.Id}} {{index .Config.Labels "lemex-web.owner"}}',
      ...ids,
    ])
    if (owners.code !== 0)
      throw new Error(`Cannot identify prior server workers: ${owners.stderr}`)
    const orphans = owners.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([, owner]) => owner !== this.owner)
      .map(([id]) => id)
    if (!orphans.length) return
    const removed = await this.#host(['rm', '-f', ...orphans])
    if (removed.code !== 0)
      throw new Error(`Cannot clean prior server workers: ${removed.stderr}`)
    this.reaped += orphans.length
  }

  toolchainSourceRoot(toolchain) {
    const root = this.toolchains.get(toolchain)
    return root ? path.join(root, 'src', 'lean') : null
  }

  info() {
    return {
      ready: this.ready,
      error: this.error,
      image: this.image,
      imageId: this.imageId || null,
      dockerVersion: this.dockerVersion || null,
      lemexCommit: this.lemexCommit || null,
      lemexNativeBuildCommit: this.lemexNativeBuildCommit || null,
      scope: this.scope,
      instance: this.instance,
      reaped: this.reaped,
      active: this.children.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      limits: { cpus: this.cpus, memory: this.memory, pids: this.pidsLimit },
      toolchains: [...this.toolchains.keys()],
    }
  }

  templates() {
    return presetDefinitions.map((preset) => ({
      ...preset,
      ready: Boolean(this.templateRoot(preset.id)),
      ...(preset.id === 'mathlib'
        ? {
            playgroundReady: Boolean(this.preparedPresetEnvironment(preset.id)),
            playgroundState: this.preparedPresets.state(preset.id),
          }
        : {}),
    }))
  }

  presetDefinition(id) {
    return presetDefinitions.find((preset) => preset.id === id)
  }

  preparedPresetEnvironment(id) {
    return this.preparedPresets.get(id)
  }

  async preparePresetEnvironment(id) {
    this.#assertReady()
    return this.preparedPresets.prepare(id)
  }

  templateRoot(id) {
    if (!presetDefinitions.some((preset) => preset.id === id)) return null
    const root = path.join(this.runtimeDir, 'templates', id)
    const marker = path.join(root, '.ready.json')
    try {
      const metadata = JSON.parse(fs.readFileSync(marker, 'utf8'))
      const preset = presetDefinitions.find((item) => item.id === id)
      if (
        metadata.toolchain !== preset.toolchain ||
        (preset.revision && metadata.revision !== preset.revision)
      )
        return null
      return root
    } catch {
      return null
    }
  }

  async home(root) {
    this.#reloadDependencies()
    return this.#prepareHome(root)
  }
  async homeForRoot(root) {
    return this.home(root)
  }

  #root(root) {
    const actual = fs.realpathSync(root)
    const owned = fs.realpathSync(this.dataDir)
    if (actual !== owned && !actual.startsWith(owned + path.sep))
      throw new Error('Worker roots must be inside the owned data directory')
    if (actual.includes(',') || actual.includes('\n'))
      throw new Error('Workspace path contains unsupported characters')
    return actual
  }

  #prepareHome(root, { fresh = false, clean = false } = {}) {
    const actual = this.#root(root)
    const key = createHash('sha256')
      .update(fresh ? `${actual}\0${randomUUID()}` : actual)
      .digest('hex')
    const home = path.join(this.runtimeDir, 'homes', key)
    const lemex = path.join(home, '.lemex')
    const elan = path.join(home, '.elan')
    ensurePrivateDirectory(this.runtimeDir, path.join('homes', key, '.lemex'))
    ensurePrivateDirectory(home, path.join('.cache', 'lake'))
    ensurePrivateDirectory(home, path.join('.elan', 'toolchains'))
    rejectSymlink(path.join(lemex, 'config.toml'))
    rejectSymlink(path.join(lemex, 'models.json'))
    rejectSymlink(path.join(elan, 'settings.toml'))
    if (!clean && !fs.existsSync(path.join(lemex, 'config.toml'))) {
      for (const filename of ['config.toml', 'models.json']) {
        const source = path.join(projectDir, '.runtime/lemex', filename)
        if (fs.existsSync(source))
          fs.copyFileSync(source, path.join(lemex, filename))
      }
    }
    for (const toolchain of this.toolchains.keys()) {
      const name = toolchainName(toolchain)
      const link = path.join(elan, 'toolchains', name)
      const target = `/opt/lean-toolchains/${name}`
      try {
        if (fs.readlinkSync(link) === target) continue
      } catch {
        /* Replace stale links. */
      }
      try {
        fs.rmSync(link, { recursive: true, force: true })
      } catch {
        /* Missing link. */
      }
      fs.symlinkSync(target, link)
    }
    fs.writeFileSync(
      path.join(elan, 'settings.toml'),
      'version = "12"\ntelemetry = false\n',
      { mode: 0o600 },
    )
    const dependencySource = this.#dependencySource(actual)
    if (dependencySource && dependencySource !== actual) {
      const sourceCache = this.#dependencyArtifactCache(dependencySource)
      const privateCache = path.join(home, '.cache/lake')
      const artifactDir = path.join(sourceCache, 'artifacts')
      if (fs.existsSync(artifactDir)) {
        const resolvedCache = fs.realpathSync(sourceCache)
        const allowed = this.#sharedSource(dependencySource)
          ? dependencySource
          : fs.realpathSync(path.join(this.runtimeDir, 'homes'))
        if (
          !resolvedCache.startsWith(allowed + path.sep) ||
          fs.realpathSync(artifactDir) !== path.join(resolvedCache, 'artifacts')
        )
          throw new Error('Dependency cache escapes the managed worker home')
        const stamp = `${dependencySource}:${fs.statSync(artifactDir).mtimeMs}`
        let current = ''
        rejectSymlink(path.join(privateCache, '.dependency-source'))
        try {
          current = fs.readFileSync(
            path.join(privateCache, '.dependency-source'),
            'utf8',
          )
        } catch {}
        if (stamp !== current) {
          ensurePrivateDirectory(home, path.join('.cache', 'lake', 'artifacts'))
          for (const file of fs.readdirSync(artifactDir, {
            withFileTypes: true,
          })) {
            if (!file.isFile()) continue
            const destination = path.join(privateCache, 'artifacts', file.name)
            try {
              fs.lstatSync(destination)
              continue
            } catch {}
            fs.symlinkSync(
              `/opt/dependency-lake-cache/artifacts/${file.name}`,
              destination,
            )
          }
          // Copy only small mutable lookup maps. Content-addressed artifacts
          // remain symlinks into a read-only mount; newly built artifacts go
          // into this workspace's private cache directory.
          for (const directory of ['outputs', 'revisions']) {
            if (fs.existsSync(path.join(sourceCache, directory))) {
              ensurePrivateDirectory(sourceCache, directory)
              ensurePrivateDirectory(privateCache, directory)
              fs.cpSync(
                path.join(sourceCache, directory),
                path.join(privateCache, directory),
                { recursive: true },
              )
            }
          }
          rejectSymlink(path.join(privateCache, '.dependency-source'))
          fs.writeFileSync(
            path.join(privateCache, '.dependency-source'),
            stamp,
            { mode: 0o600 },
          )
        }
      }
    }
    return home
  }

  #assertReady() {
    if (!this.ready)
      throw Object.assign(
        new Error(this.error || 'Runtime has not been initialized'),
        { status: 503 },
      )
    if (this.stopping)
      throw Object.assign(new Error('Runtime is shutting down'), {
        status: 503,
      })
  }

  spawn(
    root,
    args,
    {
      env = {},
      timeoutMs = 0,
      onOutput,
      network = 'none',
      signal,
      readOnlyWorkspace = false,
      writeLakeCache = false,
      freshHome = false,
      readOnlyHome = false,
      cleanHome = false,
    } = {},
  ) {
    this.#assertReady()
    if (signal?.aborted)
      throw signal.reason || new Error('Worker job was cancelled')
    if (
      !Array.isArray(args) ||
      !args.length ||
      args.some((value) => typeof value !== 'string' || value.includes('\0'))
    )
      throw new Error('Worker command must be a nonempty string argument array')
    if (
      [
        readOnlyWorkspace,
        writeLakeCache,
        freshHome,
        readOnlyHome,
        cleanHome,
      ].some((value) => typeof value !== 'boolean')
    )
      throw new Error('Worker mount options must be booleans')
    if (writeLakeCache && !readOnlyWorkspace)
      throw new Error('A writable Lake cache requires a read-only workspace')
    if (!['none', 'bridge'].includes(network))
      throw new Error('Only isolated or outbound worker networks are supported')
    if (this.children.size >= this.maxConcurrent)
      throw Object.assign(
        new Error('All workspace workers are busy; try again shortly'),
        { status: 503 },
      )
    this.#reloadDependencies()
    const actual = this.#root(root)
    const dependencySource = this.#dependencySource(actual)
    this.#checkSharedBinding(actual, dependencySource)
    const lakeCache = writeLakeCache
      ? writableLakeCache(actual, {
          mountedPackages: Boolean(dependencySource),
        })
      : null
    const home = this.#prepareHome(actual, {
      fresh: freshHome,
      clean: cleanHome,
    })
    const name = `lemex-web-${this.owner.slice(0, 8)}-${randomUUID().slice(0, 12)}`
    const dockerArgs = [
      'run',
      '--rm',
      '-i',
      '--init',
      '--name',
      name,
      '--label',
      `lemex-web.owner=${this.owner}`,
      '--label',
      `lemex-web.instance=${this.instance}`,
      '--label',
      `lemex-web.scope=${this.scope}`,
      '--user',
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      String(this.cpus),
      '--memory',
      this.memory,
      '--memory-swap',
      this.memory,
      '--pids-limit',
      String(this.pidsLimit),
      '--network',
      network,
      '--tmpfs',
      '/tmp:rw,nosuid,size=1g',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,src=${actual},dst=/workspace${readOnlyWorkspace ? ',readonly' : ''}`,
      '--mount',
      `type=bind,src=${home},dst=/home/worker${readOnlyHome ? ',readonly' : ''}`,
      '--env',
      'HOME=/home/worker',
      '--env',
      'LEMEX_HOME=/home/worker/.lemex',
      '--env',
      'ELAN_HOME=/home/worker/.elan',
      '--env',
      'LEAN_PROJECT_PATH=/workspace',
      '--env',
      'LAKE_CACHE_DIR=/home/worker/.cache/lake',
    ]
    // Place this after the read-only workspace and before the read-only
    // dependency overlay so only project-local build artifacts are writable.
    if (lakeCache)
      dockerArgs.push(
        '--mount',
        `type=bind,src=${lakeCache},dst=/workspace/.lake`,
      )
    for (const [toolchain, source] of this.toolchains) {
      dockerArgs.push(
        '--mount',
        `type=bind,src=${source},dst=/opt/lean-toolchains/${toolchainName(toolchain)},readonly`,
      )
    }
    if (dependencySource) {
      const directory = this.#dependencyPackages(dependencySource)
      if (!directory)
        throw new Error('Selected dependency packages are unavailable')
      dockerArgs.push(
        '--mount',
        `type=bind,src=${directory},dst=/workspace/.lake/packages,readonly`,
      )
      if (dependencySource !== actual) {
        const cache = this.#dependencyArtifactCache(dependencySource)
        if (fs.existsSync(path.join(cache, 'artifacts')))
          dockerArgs.push(
            '--mount',
            `type=bind,src=${cache},dst=/opt/dependency-lake-cache,readonly`,
          )
      }
    }
    const childEnv = { ...process.env }
    // Lean's executable task pool otherwise uses the host CPU count, even when
    // Docker gives this worker a smaller quota. This is a scheduler setting,
    // not a strict compiler-process limit or the Lean compiler's -j flag.
    const workerEnv = {
      ...env,
      LEAN_NUM_THREADS:
        env.LEAN_NUM_THREADS ?? String(Math.max(1, Math.floor(this.cpus))),
    }
    for (const [key, value] of Object.entries(workerEnv)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || forbiddenEnv.has(key))
        throw new Error(`Unsupported worker environment key: ${key}`)
      if (value !== undefined && value !== null) {
        childEnv[key] = String(value)
        dockerArgs.push('--env', key)
      }
    }
    dockerArgs.push(this.imageId || this.image, ...args)
    const child = spawnChild(this.docker, dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: childEnv,
    })
    child.workerHome = home
    child.containerName = name
    child.workspaceRoot = path.resolve(root)
    this.children.add(child)
    let timer
    let closing = false
    let removal
    const removeWorker = async () => {
      try {
        const result = await this.#host(['rm', '-f', name])
        if (
          result.code === 0 ||
          /No such (?:container|object)/i.test(result.stderr)
        )
          return
      } catch {
        // Cleanup failures are actionable without exposing host configuration.
      }
      throw Object.assign(
        new Error(
          'The project worker could not be stopped. Try again, or ask the server administrator to check the worker service.',
        ),
        { status: 503, workerCleanup: true },
      )
    }
    const originalKill = child.kill.bind(child)
    child.kill = (signal = 'SIGTERM') => {
      if (closing) return false
      closing = true
      child.cancelled = true
      // Killing the container removes the complete worker process tree, including
      // language servers, shell jobs, MCP tools, and agent code-mode subprocesses.
      removal = removeWorker()
      removal.catch(() => {})
      try {
        originalKill(signal)
      } catch {
        /* Already exited. */
      }
      return true
    }
    const abort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    if (timeoutMs > 0)
      timer = setTimeout(() => {
        child.timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)
    if (onOutput) {
      child.stdout.on('data', (chunk) => onOutput(chunk.toString(), 'stdout'))
      child.stderr.on('data', (chunk) => onOutput(chunk.toString(), 'stderr'))
    }
    const closed = new Promise((resolve) => child.once('close', resolve))
    let cleanup
    child.cleanupWorker = () => {
      cleanup ||= (async () => {
        await closed
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        await removal?.catch(() => {})
        // The final removal happens after the Docker client has exited, so a
        // cancelled launch cannot create its container after this check.
        await removeWorker()
        this.children.delete(child)
        this.#drain()
      })().catch((error) => {
        cleanup = undefined
        throw error
      })
      return cleanup
    }
    child.workerStopped = child.cleanupWorker()
    // Callers observe cleanup failure through run() or workerStopped. Retain
    // the child in the live set so a later project stop can retry safely.
    child.workerStopped.catch(() => {})
    return child
  }

  spawnWhenAvailable(root, args, options = {}) {
    return this.#schedule(root, args, options, true)
  }

  run(root, args, options = {}) {
    return this.#schedule(root, args, options, false)
  }

  #schedule(root, args, options, spawnOnly) {
    this.#assertReady()
    if (
      options.input !== undefined &&
      typeof options.input !== 'string' &&
      !Buffer.isBuffer(options.input)
    )
      return Promise.reject(
        new Error('Worker stdin input must be text or bytes'),
      )
    if (options.signal?.aborted)
      return Promise.reject(
        options.signal.reason || new Error('Worker job was cancelled'),
      )
    if (this.children.size < this.maxConcurrent)
      return spawnOnly
        ? Promise.resolve(this.spawn(root, args, options))
        : this.#run(root, args, options)
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(
        Object.assign(new Error('Workspace job queue is full'), {
          status: 503,
        }),
      )
    return new Promise((resolve, reject) => {
      const job = { root, args, options, resolve, reject, spawnOnly }
      const abort = () => {
        const index = this.queue.indexOf(job)
        if (index >= 0) {
          this.queue.splice(index, 1)
          reject(options.signal.reason || new Error('Worker job was cancelled'))
        }
      }
      job.abort = abort
      options.signal?.addEventListener('abort', abort, { once: true })
      this.queue.push(job)
    })
  }

  #run(root, args, options) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = this.spawn(root, args, options)
        options.onSpawn?.(child)
      } catch (error) {
        child?.kill()
        reject(error)
        return
      }
      let stdout = '',
        stderr = '',
        truncated = false
      const maxBytes = options.maxOutputBytes || 16 * 1024 * 1024
      const append = (current, chunk) => {
        if (current.length >= maxBytes) {
          truncated = true
          return current
        }
        return (current + chunk.toString()).slice(0, maxBytes)
      }
      child.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk)
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        child.workerStopped.then(
          () =>
            resolve({
              code: code ?? (child.timedOut ? 124 : 130),
              stdout,
              stderr,
              signal,
              timedOut: Boolean(child.timedOut),
              cancelled: Boolean(child.cancelled),
              truncated,
            }),
          reject,
        )
      })
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error)
      })
      child.stdin.end(options.input)
    })
  }

  #drain() {
    while (
      !this.stopping &&
      this.children.size < this.maxConcurrent &&
      this.queue.length
    ) {
      const job = this.queue.shift()
      job.options.signal?.removeEventListener('abort', job.abort)
      if (job.options.signal?.aborted) {
        job.reject(
          job.options.signal.reason || new Error('Worker job was cancelled'),
        )
        continue
      }
      if (job.spawnOnly) {
        try {
          job.resolve(this.spawn(job.root, job.args, job.options))
        } catch (error) {
          job.reject(error)
        }
      } else
        this.#run(job.root, job.args, job.options).then(job.resolve, job.reject)
    }
  }

  async prepareToolchain(toolchain, { onOutput } = {}) {
    this.#assertReady()
    if (!validToolchain.test(toolchain))
      throw new Error(
        'Only pinned official Lean 4 release toolchains are supported',
      )
    if (this.toolchains.has(toolchain)) return { toolchain, ready: true }
    if (this.installing.has(toolchain)) return this.installing.get(toolchain)
    const install = this.toolchainQueue.then(() =>
      this.#prepareToolchain(toolchain, onOutput),
    )
    this.toolchainQueue = install.catch(() => {})
    this.installing.set(toolchain, install)
    try {
      return await install
    } catch (error) {
      error.infrastructure = true
      throw error
    } finally {
      this.installing.delete(toolchain)
    }
  }

  async #prepareToolchain(toolchain, onOutput) {
    const name = toolchainName(toolchain)
    const existing = path.join(this.hostToolchainDir, name)
    let source
    if (fs.existsSync(path.join(existing, 'bin/lean'))) {
      source = fs.realpathSync(existing)
      onOutput?.(
        `Using existing ${toolchain} through a read-only mount.\n`,
        'stdout',
      )
    } else {
      const cache = ensurePrivateDirectory(this.runtimeDir, 'elan')
      onOutput?.(
        `Downloading pinned toolchain ${toolchain} into the server cache.\n`,
        'stdout',
      )
      const result = await this.#host(
        [
          'run',
          '--rm',
          '--init',
          '--name',
          `lemex-elan-${this.owner.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
          '--label',
          `lemex-web.owner=${this.owner}`,
          '--label',
          `lemex-web.instance=${this.instance}`,
          '--label',
          `lemex-web.scope=${this.scope}`,
          '--user',
          `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--cpus',
          String(this.cpus),
          '--memory',
          this.memory,
          '--pids-limit',
          String(this.pidsLimit),
          '--tmpfs',
          '/tmp:rw,nosuid,size=1g',
          '--mount',
          `type=bind,src=${cache},dst=/elan`,
          '--env',
          'ELAN_HOME=/elan',
          '--env',
          'HOME=/tmp',
          this.imageId || this.image,
          '/opt/elan/bin/elan',
          'toolchain',
          'install',
          toolchain,
        ],
        { onOutput, timeoutMs: 30 * 60 * 1000 },
      )
      if (result.code !== 0)
        throw new Error(`Lean toolchain installation failed: ${result.stderr}`)
      source = path.join(cache, 'toolchains', name)
      if (!fs.existsSync(path.join(source, 'bin/lean')))
        throw new Error(
          'Toolchain installer did not produce the expected pinned toolchain',
        )
    }
    // Verify the binary in a read-only container before trusting a cache entry.
    const check = await this.#host([
      'run',
      '--rm',
      '--label',
      `lemex-web.owner=${this.owner}`,
      '--label',
      `lemex-web.instance=${this.instance}`,
      '--label',
      `lemex-web.scope=${this.scope}`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      'none',
      '--mount',
      `type=bind,src=${source},dst=/verify,readonly`,
      this.imageId || this.image,
      '/verify/bin/lean',
      '--version',
    ])
    if (check.code !== 0 || !check.stdout.includes(toolchain.split(':v')[1]))
      throw new Error(`Toolchain version verification failed for ${toolchain}`)
    this.toolchains.set(toolchain, source)
    const registry = await this.#updateRegistry('toolchains.json', {
      set: { [toolchain]: source },
    })
    for (const [version, directory] of Object.entries(registry))
      if (
        validToolchain.test(version) &&
        fs.existsSync(path.join(directory, 'bin/lean'))
      )
        this.toolchains.set(version, directory)
    return { toolchain, ready: true }
  }

  #host(args, { onOutput, timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnChild(this.docker, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-4 * 1024 * 1024)
        onOutput?.(chunk.toString(), 'stdout')
      })
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4 * 1024 * 1024)
        onOutput?.(chunk.toString(), 'stderr')
      })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        const nameIndex = args.indexOf('--name')
        if (args[0] === 'run' && nameIndex > 0) {
          spawnChild(this.docker, ['rm', '-f', args[nameIndex + 1]], {
            stdio: 'ignore',
          }).unref()
        }
      }, timeoutMs)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 124, stdout, stderr })
      })
    })
  }

  async shutdown() {
    this.stopping = true
    for (const job of this.queue.splice(0)) {
      job.options.signal?.removeEventListener('abort', job.abort)
      job.reject(new Error('Runtime is shutting down'))
    }
    const children = [...this.children]
    for (const child of children) child.kill('SIGTERM')
    const list = await this.#host([
      'ps',
      '-aq',
      '--filter',
      `label=lemex-web.owner=${this.owner}`,
    ])
    const containers = list.stdout.trim().split(/\s+/).filter(Boolean)
    if (containers.length) await this.#host(['rm', '-f', ...containers])
    await Promise.allSettled(children.map((child) => child.workerStopped))
    await Promise.allSettled([...this.sharedCache.building.values()])
  }

  async stopProject(root) {
    const resolved = path.resolve(root)
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const job = this.queue[index]
      if (path.resolve(job.root) !== resolved) continue
      this.queue.splice(index, 1)
      job.options.signal?.removeEventListener('abort', job.abort)
      job.reject(
        Object.assign(new Error('This project stopped its queued work.'), {
          status: 409,
        }),
      )
    }
    const children = [...this.children].filter(
      (child) => child.workspaceRoot === resolved,
    )
    for (const child of children) child.kill('SIGTERM')
    const results = await Promise.allSettled(
      children.map((child) => child.cleanupWorker()),
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}

export const createRuntime = (options) => new Runtime(options)
