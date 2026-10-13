#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../server/runtime.mjs'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || process.env.LEMEX_WEB_DATA || path.join(projectDir, '.data'))
const requested = process.argv.slice(2)
const runtime = new Runtime({ dataDir, maxConcurrent: 2, memory: '8g', cpus: 4, pidsLimit: 1024 })
await runtime.init()
if (!runtime.info().ready) throw new Error(runtime.info().error)
const presets = runtime.templates().filter(p => !requested.length || requested.includes(p.id))
if (!presets.length) throw new Error('No matching presets; choose lean, mathlib, cslib, physlib')
const logs = path.join(dataDir, 'runtime/logs')
await fs.mkdir(logs, { recursive: true })
let failures = 0

for (const preset of presets) {
  if (runtime.templateRoot(preset.id)) { console.log(`${preset.id}: ready, skipping existing verified template`); continue }
  const logFile = path.join(logs, `${preset.id}-bootstrap.log`)
  try {
    if ((await fs.stat(logFile)).size) await fs.copyFile(logFile, `${logFile}.${new Date().toISOString().replaceAll(':', '-')}`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await fs.writeFile(logFile, '')
  const append = chunk => fs.appendFile(logFile, chunk).catch(() => {})
  const execute = async (root, args, network = 'bridge', allowFailure = false) => {
    console.log(`${preset.id}: ${args.join(' ')}`)
    append(`\n$ ${args.join(' ')}\n`)
    const result = await runtime.run(root, args, { network, onOutput: append, timeoutMs: 90 * 60 * 1000, maxOutputBytes: 256 * 1024 })
    if (result.code !== 0 && !allowFailure) throw new Error(`Command failed (${result.code}): ${args.join(' ')}\n${result.stderr.slice(-4000)}`)
    return result
  }
  try {
    await runtime.prepareToolchain(preset.toolchain, { onOutput: append })
    const root = path.join(dataDir, 'runtime/templates', preset.id)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'lean-toolchain'), preset.toolchain + '\n')
    let lakefile = 'name = "ProofWorkspace"\nversion = "0.1.0"\ndefaultTargets = ["Main"]\n\n[[lean_lib]]\nname = "Main"\n'
    if (preset.repository) lakefile += `\n[[require]]\nname = ${JSON.stringify(preset.package)}\ngit = ${JSON.stringify(preset.repository)}\nrev = ${JSON.stringify(preset.revision)}\n`
    await fs.writeFile(path.join(root, 'lakefile.toml'), lakefile)
    await fs.writeFile(path.join(root, 'Main.lean'), `import ${preset.import}\n\n/-- Start a proof here, or select code and ask Lemex for help. -/\ntheorem addition_commutes (a b : Nat) : a + b = b + a := by\n  exact Nat.add_comm a b\n`)
    if (preset.repository) {
      await execute(root, ['lake', 'update'])
      await execute(root, ['lake', 'exe', 'cache', 'get'], 'bridge', true)
      if (preset.id === 'physlib') {
        // This executable restores Physlib's Lake artifact cache, in addition to
        // Mathlib's cache. Invoke it in its exact dependency source checkout.
        await execute(root, ['sh', '-c', 'cd .lake/packages/Physlib && lake exe get_cache'], 'bridge', true)
      }
    }
    await execute(root, ['lake', 'build', 'Main'], 'bridge')
    const checked = await execute(root, ['lake', 'env', 'lean', 'Main.lean'], 'none')
    if (preset.repository) {
      const candidate = path.join(dataDir, 'runtime/template-check', preset.id)
      await fs.mkdir(candidate, { recursive: true })
      await fs.cp(root, candidate, { recursive: true, filter: filename => !filename.startsWith(path.join(root, '.lake/packages')) })
      await runtime.inheritDependencies(root, candidate)
      await execute(candidate, ['lake', 'env', 'lean', 'Main.lean'], 'none')
      await execute(candidate, ['lake', 'build', 'Main'], 'none')
    }
    await fs.writeFile(path.join(root, '.ready.json'), JSON.stringify({ id: preset.id, toolchain: preset.toolchain, revision: preset.revision || null, verifiedAt: new Date().toISOString(), workerImage: runtime.info().imageId, lemexCommit: runtime.info().lemexCommit, command: 'lake env lean Main.lean', code: checked.code }, null, 2) + '\n')
    console.log(`${preset.id}: ready; pinned dependency import verified with outbound network disabled`)
  } catch (error) {
    failures++
    console.error(`${preset.id}: ${error.message}\nFull log: ${logFile}`)
  }
}
await runtime.shutdown()
if (failures) process.exitCode = 1
