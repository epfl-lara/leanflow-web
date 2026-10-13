import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { optimizationPaths, optimizationReductions, optimizationBaselineContext } from '../agent-optimization.mjs'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

test('optimization targets only selected local Lean sources and keeps actual decreases or increases', () => {
  assert.deepEqual(optimizationPaths({ file: 'Main.lean', files: ['Main.lean', 'Proofs/A.lean', 'Notes.md', '.lake/packages/mathlib/Mathlib.lean', 'Nested/lakefile.lean'] }), ['Main.lean', 'Proofs/A.lean'])
  const baseline = { available: true, proofTokens: 20, totalHeartbeatsRaw: 2000, heartbeats: 2 }
  const candidate = { available: true, proofTokens: 15, totalHeartbeatsRaw: 3000, heartbeats: 3 }
  assert.deepEqual(optimizationReductions(baseline, candidate), { proofTokens: 5, heartbeatsRaw: -1000, heartbeats: -1, proofTokensPercent: 25, heartbeatsPercent: -50 })
  assert.equal(optimizationReductions(baseline, { available: false, reason: 'unsupported' }), null)
  const zero = optimizationReductions({ available: true, proofTokens: 0, totalHeartbeatsRaw: 0, heartbeats: 0 }, { available: true, proofTokens: 0, totalHeartbeatsRaw: 0, heartbeats: 0 })
  assert.equal(zero.proofTokensPercent, null)
  assert.equal(zero.heartbeatsPercent, null)
})

test('optimization context reports measured values and unavailable reasons without competition claims', () => {
  const measured = optimizationBaselineContext({ compiled: true, available: true, proofTokens: 7, heartbeats: 2 })
  assert(measured.includes('"proofTokens": 7'))
  assert(measured.includes('not official competition scores'))
  const unavailable = optimizationBaselineContext({ compiled: null, available: false, proofTokens: null, heartbeats: null, reason: 'unsupported syntax' })
  assert(unavailable.startsWith('Saved-proof cost measurement is unavailable'))
  assert(unavailable.includes('unsupported syntax'))
})

test('Optimize validates a selected proof and rejects an invalid baseline before any provider worker starts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-opt-agent-'))
  const events = new EventStore(root), measurements = []
  t.after(() => { events.close(); return fs.rm(root, { recursive: true, force: true }) })
  const baseline = { compiled: false, available: false, proofTokens: null, heartbeats: null, reason: 'Lean compilation failed.' }
  const manager = new AgentManager({
    events, maxConcurrent: 1, settings: {},
    workspaces: { get: id => ({ id, status: 'ready' }), readFile: async () => ({ content: 'theorem broken : False := by rfl' }), snapshot: async () => ({ root, projectId: 'p', owner: 'alice', sourceRevision: 'original' }) },
    runtime: { spawn() { assert.fail('Invalid baseline must never start a provider worker') }, home() { assert.fail('Invalid baseline does not need agent credentials or config') } },
    optimizationMeasure: async (...args) => { measurements.push(args); return baseline },
    config: { provider: { LEMEX_API_KEY: 'fake' }, defaultModel: 'model', models: [{ id: 'model' }], redact: String },
  })
  for (const files of [[], ['Notes.md'], ['.lake/packages/mathlib/Mathlib.lean'], ['Nested/lakefile.lean']]) await assert.rejects(() => manager.start('alice', 'p', { mode: 'optimize', prompt: 'Reduce proof cost.', files }), { status: 400 })
  const job = (await manager.start('alice', 'p', { mode: 'optimize', prompt: 'Reduce proof cost.', files: ['Main.lean'], liveEdits: false }))
  await new Promise(resolve => events.on(job.id, event => { if (event.type === 'status' && event.data.status === 'failed') resolve() }))
  await manager.shutdown()
  assert.equal(measurements.length, 1)
  assert.equal(measurements[0][1], root)
  assert.deepEqual(measurements[0][2], ['Main.lean'])
  assert(measurements[0][3].signal instanceof AbortSignal)
  assert.equal(events.get(job.id).optimization.baseline.compiled, false)
  assert.match(events.get(job.id).error, /already valid proof.*Repair/)
  assert.equal(events.get(job.id).optimization.candidate, undefined)
})

test('optimization measures a protected baseline and only measures the clean candidate after independent audit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-opt-rpc-'))
  const candidateRoot = path.join(root, 'candidate'), cleanRoot = path.join(root, 'verified'), home = path.join(root, 'home')
  await fs.mkdir(candidateRoot, { recursive: true }); await fs.mkdir(cleanRoot, { recursive: true }); await fs.mkdir(path.join(home, '.lemex'), { recursive: true })
  const original = 'theorem fixture : True := by\n  exact True.intro\n', final = 'theorem fixture : True := by\n  trivial\n'
  await fs.writeFile(path.join(candidateRoot, 'Main.lean'), original)
  const events = new EventStore(root), timeline = [], requests = []
  const runtime = {
    home: async () => home,
    run: async (cwd, args) => {
      assert.equal(cwd, cleanRoot)
      if (args[1] === 'env') return { code: 0, stdout: JSON.stringify({ LEAN_SYSROOT: '/opt/lean-toolchains/fixture', LEAN_PATH: '/workspace/.lake/build/lib/lean', LEAN_SRC_PATH: '/workspace' }), stderr: '' }
      if (args[1] === 'build') { timeline.push('build'); return { code: 0, stdout: '', stderr: '' } }
      timeline.push('independent-audit')
      return { code: 0, stdout: JSON.stringify({ compiled: true, complete: true, kernelChecked: true, files: [{ path: 'Main.lean' }], axioms: [], errors: [], warnings: [] }), stderr: '' }
    },
    spawn: cwd => {
      assert.equal(cwd, candidateRoot); timeline.push('native-start')
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.stderr = new PassThrough()
      const send = value => child.stdout.write(JSON.stringify(value) + '\n')
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        for (const line of chunk.toString().trim().split('\n')) {
          const request = JSON.parse(line); requests.push(request)
          if (request.id !== undefined) queueMicrotask(async () => {
            send({ id: request.id, result: request.method === 'thread/start' ? { thread: { id: 'fresh' } } : request.method === 'turn/start' ? { turn: { id: 'turn' } } : {} })
            if (request.method === 'turn/start') {
              await fs.writeFile(path.join(candidateRoot, 'Main.lean'), final)
              send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } })
            }
          })
        }
        callback()
      } })
      child.kill = () => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); return true }
      return child
    },
  }
  const baseline = { compiled: true, available: true, proofTokens: 20, totalHeartbeatsRaw: 2000, heartbeats: 2 }
  const candidate = { compiled: true, available: true, proofTokens: 15, totalHeartbeatsRaw: 1000, heartbeats: 1 }
  const manager = new AgentManager({ events, runtime,
    workspaces: {
      get: id => ({ id, status: 'ready', toolchain: 'leanprover/lean4:v4.34.1' }),
      readFile: async () => ({ content: original }),
      snapshot: async () => ({ root: candidateRoot, projectId: 'p', owner: 'alice', sourceRevision: 'original' }),
      changes: async () => [{ path: 'Main.lean', before: original, after: final }],
      verificationCopy: async (_snapshot, changes, options) => { assert.deepEqual(options, {}); await fs.writeFile(path.join(cleanRoot, 'Main.lean'), changes[0].after); return { root: cleanRoot } },
    },
    optimizationMeasure: async (_runtime, cwd, paths) => {
      assert.deepEqual(paths, ['Main.lean'])
      const first = cwd === candidateRoot
      timeline.push(first ? 'baseline-cost' : 'candidate-cost')
      assert.equal(await fs.readFile(path.join(cwd, 'Main.lean'), 'utf8'), first ? original : final)
      return first ? baseline : candidate
    },
    settings: { get: async () => ({ showReasoning: true, extraInstructions: '', tools: { lean: false, lean_explore: false, exa: false } }) },
    config: { provider: { LEMEX_API_KEY: 'fake' }, defaultModel: 'model', models: [{ id: 'model' }], redact: String },
  })
  t.after(async () => { await manager.shutdown(); events.close(); await fs.rm(root, { recursive: true, force: true }) })
  const job = (await manager.start('alice', 'p', { mode: 'optimize', prompt: 'Reduce this proof cost.', files: ['Main.lean'], liveEdits: false }))
  await new Promise(resolve => events.on(job.id, event => { if (event.type === 'status' && ['completed', 'failed'].includes(event.data.status)) resolve() }))
  await manager.shutdown()
  const result = events.get(job.id)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.verification.complete, true)
  assert.deepEqual(timeline, ['baseline-cost', 'native-start', 'build', 'independent-audit', 'candidate-cost'])
  assert.equal(result.optimization.baseline.proofTokens, 20)
  assert.equal(result.optimization.candidate.proofTokens, 15)
  assert.equal(result.optimization.reductions.proofTokens, 5)
  const userText = requests.find(request => request.method === 'turn/start').params.input[0].text
  assert(userText.includes('"totalHeartbeatsRaw": 2000'))
  assert(userText.includes('"proofTokens": 20'))
  assert(userText.endsWith('Current task:\nReduce this proof cost.'))
})
