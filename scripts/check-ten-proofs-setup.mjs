import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'
import {
  repository,
  revision,
  toolchain,
  modules,
  expectedFiles,
  dependencies,
  parseOptions,
  validateDependencySources,
  seedDependencySources,
} from './ten-proofs-fixture.mjs'

const help = `Check the pinned public ten-proofs import with cold and warm projects.

Usage: node scripts/check-ten-proofs-setup.mjs [options]
  --image NAME                    Docker worker image (lemex-web-worker:local)
  --cpus NUMBER                   CPUs per worker (6)
  --memory SIZE                   Memory per worker (24g)
  --timeout-minutes NUMBER        Total check deadline (240)
  --build-timeout-minutes N       Setup and explicit All build deadline (90)
  --import-timeout-minutes N      Import and snapshot deadline (10)
  --dependency-sources DIRECTORY  Optional exact public source checkouts
  --help                          Show this message without starting workers

Runs one helper worker at a time, without agent providers or production data.
Reports, logs and test workspaces remain in a unique .runtime/ directory.
LEAN_NUM_THREADS=1 limits Lake scheduling; it is not a compiler thread limit.
`

const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const owner = 'ten-proofs-check'

async function verifySources(workspace) {
  for (const [filename, expected] of Object.entries(expectedFiles)) {
    const content = await fs.readFile(path.join(workspace, filename))
    assert.equal(
      content.length,
      expected.bytes,
      `Changed file size: ${filename}`,
    )
    assert.equal(
      sha256(content),
      expected.sha256,
      `Changed pinned source: ${filename}`,
    )
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    console.log(help)
    return
  }
  assert(
    Number(process.versions.node.split('.')[0]) >= 24,
    'Use Node 24 or newer',
  )
  const directory = path.join(
    root,
    '.runtime',
    `ten-proofs-check-${randomUUID()}`,
  )
  const dataDir = path.join(directory, 'data')
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const controller = new AbortController()
  const signal = controller.signal
  const interrupted = (name) =>
    controller.abort(new Error(`Check stopped by ${name}`))
  const onInterrupt = () => interrupted('SIGINT')
  const onTerminate = () => interrupted('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  const deadline = setTimeout(
    () => controller.abort(new Error('Total check deadline exceeded')),
    options.timeoutMs,
  )
  const runtime = new Runtime({
    dataDir,
    image: options.image,
    cpus: options.cpus,
    memory: options.memory,
    maxConcurrent: 1,
    scope: 'helper',
    // Keep toolchain downloads in this fixture instead of consulting a host installation.
    hostToolchainDir: path.join(dataDir, 'unused-host-toolchains'),
  })
  const report = {
    startedAt: new Date().toISOString(),
    repository,
    revision,
    toolchain,
    directory,
    dataDir,
    providerCalls: 0,
    resources: {
      workers: 1,
      cpus: options.cpus,
      memory: options.memory,
      lakeSchedulerThreads: 1,
    },
    deadlines: {
      totalMs: options.timeoutMs,
      buildMs: options.buildTimeoutMs,
      importMs: options.importTimeoutMs,
    },
    sourceAssistance: {
      requested: Boolean(options.dependencySources),
      used: false,
      compiledArtifactsSeeded: false,
      trackedUpstreamTraceHashPolicy:
        'Only unchanged trace/hash support files tracked in the exact public commit are retained. Local .lake state and compiled Lean/native artifacts are rejected even if tracked.',
    },
    dependencies,
    expectedFiles,
    commands: [],
    projects: [],
    passed: false,
  }
  const reportPath = path.join(directory, 'report.json')
  const save = () =>
    fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    })
  console.log(`Checking ten-proofs. Report: ${reportPath}`)
  let store
  let sources
  const isolationMarker = `isolation-${randomUUID()}.txt`
  const seeded = new Set()
  const actualRun = runtime.run.bind(runtime)
  runtime.run = async (workspace, args, commandOptions = {}) => {
    signal.throwIfAborted()
    const stageRoot =
      path.join(runtime.runtimeDir, 'shared-dependency-stages') + path.sep
    if (
      sources &&
      workspace.startsWith(stageRoot) &&
      args[0] === 'lake' &&
      !seeded.has(workspace)
    ) {
      await seedDependencySources(sources, workspace, dependencies, signal)
      seeded.add(workspace)
      report.sourceAssistance.used = true
      await save()
    }
    const id = report.commands.length + 1
    const started = Date.now()
    const command = { id, args, workspace, startedAt: new Date().toISOString() }
    report.commands.push(command)
    const log = path.join(directory, `command-${id}.log`)
    await fs.writeFile(log, `${JSON.stringify({ args, workspace })}\n`, {
      mode: 0o600,
    })
    let writes = Promise.resolve()
    console.log(`Command ${id}: ${args.join(' ')}`)
    try {
      const result = await actualRun(workspace, args, {
        ...commandOptions,
        env: { ...commandOptions.env, LEAN_NUM_THREADS: '1' },
        signal,
        cleanHome: true,
        onOutput: (message) => {
          const output =
            typeof message === 'string'
              ? message
              : message?.text || message?.data || ''
          writes = writes.then(() => fs.appendFile(log, output))
          commandOptions.onOutput?.(message)
        },
      })
      Object.assign(command, {
        code: result.code,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        stderrTail: result.stderr.slice(-4000),
      })
      return result
    } catch (error) {
      command.error = error.message
      throw error
    } finally {
      await writes
      command.ms = Date.now() - started
      await save()
    }
  }
  try {
    for (const filename of [
      'server/runtime.mjs',
      'server/workspaces.mjs',
      'server/shared-dependencies.mjs',
    ]) {
      report.applicationModules ||= {}
      report.applicationModules[filename] = sha256(
        await fs.readFile(path.join(root, filename)),
      )
    }
    if (options.dependencySources) {
      sources = await validateDependencySources(
        options.dependencySources,
        dependencies,
        signal,
      )
      report.sourceAssistance.directory = sources
    }
    const initialized = await runtime.init()
    assert.equal(initialized.ready, true, initialized.error)
    report.workerImage = initialized.imageId
    store = await new WorkspaceStore({
      dataDir,
      runtime,
      setupBuildTimeoutMs: options.buildTimeoutMs,
      setupRepair: async () => {
        report.providerCalls++
        throw new Error('Provider repair is disabled in this check')
      },
    }).init()
    for (const phase of ['cold', 'warm']) {
      signal.throwIfAborted()
      const started = Date.now()
      const created = await store.create(owner, {
        name: `Ten proofs ${phase}`,
        repository,
        revision,
        autoRepair: false,
      })
      const result = { phase, id: created.id, files: {} }
      report.projects.push(result)
      await save()
      await store.jobs.get(created.id)
      signal.throwIfAborted()
      const project = store.get(created.id, owner)
      Object.assign(result, {
        status: project.status,
        error: project.error,
        buildWarning: project.buildWarning,
        defaultTargetsBuilt:
          project.status === 'ready' && !project.buildWarning,
        setupMs: Date.now() - started,
        root: project.root,
        dependencyRoot: runtime.dependencyRoot(project.root),
      })
      await save()
      assert.equal(project.status, 'ready', project.error)
      assert.equal(project.buildWarning, undefined, project.buildWarning)
      assert.equal(project.toolchain, toolchain, 'Lean pin changed')
      assert.equal(
        project.sourceRevision,
        revision,
        'Repository revision changed',
      )
      assert(
        result.dependencyRoot && result.dependencyRoot !== project.root,
        'Imported project did not use the shared dependency cache',
      )
      await verifySources(project.root)
      result.pinsAndSourcesPreserved = true
      if (phase === 'cold')
        await fs.writeFile(
          path.join(project.root, isolationMarker),
          'Private cold-project fixture\n',
          { mode: 0o600 },
        )
      else {
        await assert.rejects(
          fs.stat(path.join(project.root, isolationMarker)),
          { code: 'ENOENT' },
        )
        result.privateFilesIsolated = true
      }
      for (const module of modules) {
        const filename = `${module}.lean`
        const file = await store.readFile(project.id, owner, filename)
        assert.equal(
          sha256(file.content),
          expectedFiles[filename].sha256,
          `File API changed ${filename}`,
        )
        result.files[filename] = {
          opened: true,
          bytes: Buffer.byteLength(file.content),
          hash: file.hash,
        }
      }
      for (const pkg of dependencies) {
        const checked = await runtime.run(
          project.root,
          ['git', '-C', `.lake/packages/${pkg.name}`, 'rev-parse', 'HEAD'],
          { network: 'none', timeoutMs: 30_000 },
        )
        assert.equal(checked.code, 0, checked.stderr)
        assert.equal(
          checked.stdout.trim(),
          pkg.rev,
          `Dependency pin changed: ${pkg.name}`,
        )
      }
      result.dependencyPinsPreserved = true
      const all = await runtime.run(
        project.root,
        ['lake', '--keep-toolchain', 'build', 'All'],
        {
          network: 'none',
          readOnlyWorkspace: true,
          writeLakeCache: true,
          timeoutMs: options.buildTimeoutMs,
        },
      )
      result.allBuild = { code: all.code, timedOut: all.timedOut }
      await save()
      assert.equal(all.code, 0, all.stderr)
      const checkImport = async (workspace) => {
        const checked = await runtime.run(
          workspace,
          ['lake', '--keep-toolchain', 'env', 'lean', '--stdin'],
          {
            input: 'import All\nexample (n : Nat) : n + 0 = n := by simp\n',
            network: 'none',
            readOnlyWorkspace: true,
            writeLakeCache: true,
            timeoutMs: options.importTimeoutMs,
          },
        )
        assert.equal(checked.code, 0, checked.stderr)
      }
      await checkImport(project.root)
      result.allImportsPassed = true
      const marker = `.lake/packages/mathlib/readonly-${randomUUID()}`
      const denied = await runtime.run(project.root, ['touch', marker], {
        network: 'none',
        timeoutMs: 30_000,
      })
      assert.notEqual(denied.code, 0, 'Shared dependency mount was writable')
      assert.match(
        denied.stderr,
        /read-only file system/i,
        'Write failed for a reason other than a read-only mount',
      )
      result.sharedReadonly = true
      const snapshot = await store.snapshot(project.id, owner, randomUUID())
      assert.equal(
        runtime.dependencyRoot(snapshot.root),
        result.dependencyRoot,
        'Snapshot did not reuse the pinned dependencies',
      )
      await verifySources(snapshot.root)
      await checkImport(snapshot.root)
      result.snapshotImportsPassed = true
      await verifySources(project.root)
      result.ms = Date.now() - started
      await save()
      console.log(
        `${phase} project passed in ${Math.round(result.ms / 1000)} seconds`,
      )
    }
    assert.notEqual(report.projects[0].root, report.projects[1].root)
    assert.equal(
      report.projects[0].dependencyRoot,
      report.projects[1].dependencyRoot,
      'Warm project did not reuse the exact cache',
    )
    assert.equal(report.providerCalls, 0)
    report.sharedCacheReused = true
    report.passed = true
  } catch (error) {
    report.error = error.stack || error.message
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    controller.abort(new Error('Check finished'))
    await runtime.shutdown().catch((error) => {
      report.shutdownError = error.message
      report.passed = false
      process.exitCode = 1
    })
    if (store) {
      await Promise.allSettled([...store.jobs.values()])
      store.close()
    }
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
    report.finishedAt = new Date().toISOString()
    await save()
    console.log(`${report.passed ? 'Passed' : 'Failed'}. Report: ${reportPath}`)
    if (report.error) console.error(report.error)
  }
}

await main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
