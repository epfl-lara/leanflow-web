import { DatabaseSync } from 'node:sqlite'
import { promises as fs, chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { processIdentity } from './lease.mjs'

// The server and provisioning CLI share one installer and an atomic lease.
// A killed installer can be resumed without two processes writing one cache.
export class PresetInstaller {
  constructor(runtime) {
    this.runtime = runtime
    this.states = new Map()
    this.controller = new AbortController()
    this.pending = null
    this.db = null
  }

  open() {
    if (this.db) return
    const filename = path.join(this.runtime.runtimeDir, 'preset-install.sqlite')
    this.db = new DatabaseSync(filename)
    chmodSync(filename, 0o600)
    this.db.exec(
      'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS installs (id TEXT PRIMARY KEY, owner TEXT, token TEXT, state TEXT NOT NULL)',
    )
  }

  live(owner) {
    if (!owner) return false
    const saved = JSON.parse(owner),
      current = processIdentity(saved.pid)
    return (
      Boolean(current) &&
      current.bootId === saved.bootId &&
      current.startTime === saved.startTime
    )
  }

  state(id) {
    if (this.runtime.templateRoot(id)) return 'ready'
    const row = this.db
      ?.prepare('SELECT owner, state FROM installs WHERE id=?')
      .get(id)
    if (row?.state === 'preparing' && this.live(row.owner)) return 'preparing'
    return (
      this.states.get(id) ||
      (row?.state === 'failed' ? 'failed' : 'unavailable')
    )
  }

  claim(id, token) {
    const owner = processIdentity()
    if (!owner) throw new Error('Cannot identify the preset installer process')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare('SELECT owner FROM installs WHERE id=?')
        .get(id)
      if (this.live(row?.owner)) return false
      this.db
        .prepare(
          "INSERT INTO installs VALUES (?, ?, ?, 'preparing') ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, token=excluded.token, state=excluded.state",
        )
        .run(
          id,
          JSON.stringify({ ...owner, workerOwner: this.runtime.owner }),
          token,
        )
      return { previous: row?.owner ? JSON.parse(row.owner) : null }
    } finally {
      this.db.exec('COMMIT')
    }
  }

  prepareAll({ ids, onProgress = () => {}, onReady = () => {} } = {}) {
    if (this.pending) return this.pending
    this.open()
    const presets = this.runtime
      .templates()
      .filter((p) => !ids?.length || ids.includes(p.id))
    if (!presets.length || ids?.some((id) => !presets.some((p) => p.id === id)))
      throw new Error('Choose lean, mathlib, cslib, or physlib')
    for (const preset of presets)
      if (!preset.ready) this.states.set(preset.id, 'queued')
    const signal = this.controller.signal
    this.pending = (async () => {
      let failures = 0
      for (const preset of presets) {
        if (signal.aborted) break
        const token = randomUUID()
        let claimed = false
        let abandoned = null
        try {
          while (!this.runtime.templateRoot(preset.id)) {
            signal.throwIfAborted()
            const lease = this.claim(preset.id, token)
            if (lease) {
              claimed = true
              // Docker jobs can outlive a killed provisioning CLI. Stop only
              // workers owned by the dead lease holder before resuming writes.
              if (lease.previous?.workerOwner) {
                abandoned = lease.previous
                await this.runtime.stopOrphanedPresetWorkers(
                  lease.previous.workerOwner,
                )
                abandoned = null
              }
              break
            }
            await delay(2000, undefined, { signal })
          }
          if (this.runtime.templateRoot(preset.id)) {
            this.states.set(preset.id, 'ready')
            await onReady(preset.id)
            continue
          }
          this.states.set(preset.id, 'preparing')
          await this.install(preset, signal, onProgress)
          this.states.set(preset.id, 'ready')
          await onReady(preset.id)
        } catch (error) {
          failures++
          this.states.set(preset.id, signal.aborted ? 'queued' : 'failed')
          if (!signal.aborted)
            onProgress(preset.id, `Preparation failed: ${error.message}`)
        } finally {
          if (claimed)
            this.db
              .prepare(
                'UPDATE installs SET owner=?, token=NULL, state=? WHERE id=? AND token=?',
              )
              .run(
                abandoned ? JSON.stringify(abandoned) : null,
                this.states.get(preset.id) || 'failed',
                preset.id,
                token,
              )
        }
      }
      return { failures }
    })().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  async install(preset, signal, onProgress) {
    const runtime = this.runtime
    const logs = path.join(runtime.runtimeDir, 'logs')
    await fs.mkdir(logs, { recursive: true, mode: 0o700 })
    const logFile = path.join(logs, `${preset.id}-bootstrap.log`)
    const log = await fs.open(logFile, 'a', 0o600)
    let writes = Promise.resolve()
    const append = (chunk) => {
      writes = writes.then(() => log.write(String(chunk))).catch(() => {})
    }
    const execute = async (
      root,
      args,
      network = 'bridge',
      allowFailure = false,
    ) => {
      signal.throwIfAborted()
      onProgress(preset.id, args.join(' '))
      append(`\n$ ${args.join(' ')}\n`)
      const result = await runtime.run(root, args, {
        signal,
        network,
        onOutput: append,
        timeoutMs: 90 * 60 * 1000,
        maxOutputBytes: 256 * 1024,
      })
      signal.throwIfAborted()
      if (result.code !== 0 && !allowFailure)
        throw new Error(
          `Command failed (${result.code}): ${args.join(' ')}\n${result.stderr.slice(-4000)}`,
        )
      return result
    }
    try {
      signal.throwIfAborted()
      await runtime.prepareToolchain(preset.toolchain, { onOutput: append })
      signal.throwIfAborted()
      // Versioned roots preserve caches still mounted by older projects.
      const root = runtime.templateInstallRoot(preset.id)
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      await fs.writeFile(
        path.join(root, 'lean-toolchain'),
        preset.toolchain + '\n',
      )
      let lakefile =
        'name = "ProofWorkspace"\nversion = "0.1.0"\ndefaultTargets = ["Main"]\n\n[[lean_lib]]\nname = "Main"\n'
      if (preset.repository)
        lakefile += `\n[[require]]\nname = ${JSON.stringify(preset.package)}\ngit = ${JSON.stringify(preset.repository)}\nrev = ${JSON.stringify(preset.revision)}\n`
      await fs.writeFile(path.join(root, 'lakefile.toml'), lakefile)
      const imports = ['cslib', 'physlib'].includes(preset.id)
        ? ['Mathlib', preset.import]
        : [preset.import]
      await fs.writeFile(
        path.join(root, 'Main.lean'),
        `${imports.map((name) => `import ${name}`).join('\n')}\n\n/-- Start a proof here, or select code and ask Lemex for help. -/\ntheorem addition_commutes (a b : Nat) : a + b = b + a := by\n  exact Nat.add_comm a b\n`,
      )
      if (preset.repository) {
        await execute(root, ['lake', 'update'])
        await execute(root, ['lake', 'exe', 'cache', 'get'], 'bridge', true)
        if (preset.id === 'physlib')
          await execute(
            root,
            ['sh', '-c', 'cd .lake/packages/Physlib && lake exe get_cache'],
            'bridge',
            true,
          )
      }
      await execute(root, ['lake', 'build', 'Main'])
      const checked = await execute(
        root,
        ['lake', 'env', 'lean', 'Main.lean'],
        'none',
      )
      if (preset.repository) {
        const parent = path.join(runtime.runtimeDir, 'template-check')
        await fs.mkdir(parent, { recursive: true })
        const candidate = await fs.mkdtemp(path.join(parent, `${preset.id}-`))
        await runtime.claimTemporaryWorkspace(candidate)
        try {
          const packages = path.join(root, '.lake', 'packages')
          await fs.cp(root, candidate, {
            recursive: true,
            filter: (filename) =>
              filename !== packages &&
              !filename.startsWith(packages + path.sep),
          })
          await runtime.inheritDependencies(root, candidate)
          await execute(candidate, ['lake', 'env', 'lean', 'Main.lean'], 'none')
          await execute(candidate, ['lake', 'build', 'Main'], 'none')
        } finally {
          await runtime.releaseTemporaryWorkspace(candidate)
        }
      }
      signal.throwIfAborted()
      const marker = {
        id: preset.id,
        toolchain: preset.toolchain,
        revision: preset.revision || null,
        verifiedAt: new Date().toISOString(),
        workerImage: runtime.info().imageId,
        lemexCommit: runtime.info().lemexCommit,
        command: 'lake env lean Main.lean',
        code: checked.code,
      }
      await fs.writeFile(
        path.join(root, '.ready.json.tmp'),
        JSON.stringify(marker, null, 2) + '\n',
      )
      await fs.rename(
        path.join(root, '.ready.json.tmp'),
        path.join(root, '.ready.json'),
      )
      onProgress(preset.id, 'Ready; imports and build verified offline')
    } catch (error) {
      append(`\nPreparation failed: ${error.message}\n`)
      throw error
    } finally {
      await writes
      await log.close()
    }
  }

  stop() {
    this.controller.abort(new Error('Server is shutting down'))
  }
  async close() {
    this.stop()
    await this.pending
    this.db?.close()
    this.db = null
  }
}
