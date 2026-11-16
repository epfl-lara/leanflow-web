import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  setupRequestPurpose,
  assertSetupRequestChanges,
} from '../setup-request-policy.mjs'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'

const pin = 'leanprover/lean4:v4.19.0\n'
const dependency = {
  type: 'git',
  name: 'library',
  url: 'https://github.com/example/library',
  rev: 'a'.repeat(40),
  subDir: 'Lean',
}
const lock = (packages) => JSON.stringify({ packages })

test('setup help is explicitly scoped and review-first; ordinary requests keep their existing policy', () => {
  assert.equal(
    setupRequestPurpose({ mode: 'proofs', liveEdits: true }),
    undefined,
  )
  assert.equal(
    setupRequestPurpose({ purpose: 'setup', mode: 'search', liveEdits: false }),
    'setup',
  )
  for (const input of [
    null,
    [],
    undefined,
    { purpose: 'unknown', mode: 'search', liveEdits: false },
    { purpose: 'setup', mode: 'proofs', liveEdits: false },
    { purpose: 'setup', mode: 'search', liveEdits: true },
    { purpose: 'setup', mode: 'search' },
  ])
    assert.throws(() => setupRequestPurpose(input), { status: 400 })
})

test('setup help cannot silently repair a build by changing sources, Lean pins or dependency sources', () => {
  for (const changes of [
    [
      {
        path: 'Main.lean',
        before: 'theorem original : True := by trivial',
        after: 'axiom original : True',
      },
    ],
    [{ path: 'nested/lakefile.toml', before: null, after: 'name = "other"' }],
    [
      {
        path: 'lean-toolchain',
        before: pin,
        after: 'leanprover/lean4:v4.35.0',
      },
    ],
    [{ path: 'lean-toolchain', before: pin, after: null }],
    [
      {
        path: 'lean-toolchain',
        before: 'leanprover/lean4:nightly-2026-01-01',
        after: pin,
      },
    ],
    [
      {
        path: 'lake-manifest.json',
        before: lock([dependency]),
        after: lock([{ ...dependency, rev: 'b'.repeat(40) }]),
      },
    ],
    [
      {
        path: 'lake-manifest.json',
        before: lock([dependency]),
        after: lock([{ ...dependency, subDir: 'Other' }]),
      },
    ],
    [
      {
        path: 'lake-manifest.json',
        before: lock([dependency]),
        after: lock([{ ...dependency, type: 'path', dir: 'vendor/library' }]),
      },
    ],
    [
      {
        path: 'lake-manifest.json',
        before: lock([{ name: 'local', type: 'path', dir: 'vendor/local' }]),
        after: lock([
          {
            name: 'local',
            type: 'git',
            url: 'https://github.com/example/local',
            rev: 'a'.repeat(40),
          },
        ]),
      },
    ],
  ])
    assert.throws(() => assertSetupRequestChanges(changes), { status: 409 })
  assert.doesNotThrow(() =>
    assertSetupRequestChanges([
      {
        path: 'lakefile.toml',
        before: 'invalid',
        after: 'name = "repaired"\n',
      },
      { path: 'lean-toolchain', before: pin, after: pin.trim() },
      {
        path: 'lake-manifest.json',
        before: lock([dependency]),
        after: lock([{ ...dependency, inherited: true }]),
      },
    ]),
  )
  assert.doesNotThrow(() =>
    assertSetupRequestChanges([
      { path: 'lean-toolchain', before: null, after: pin },
    ]),
  )
})

test('persisted setup candidates enforce their scope again when applied, before writing any project file', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-request-'))
  const events = new EventStore(dataDir)
  let writes = 0
  const manager = new AgentManager({
    events,
    runtime: {},
    settings: {},
    config: { redact: String },
    workspaces: {
      get: (id) => ({ id, status: 'error', needsPreparation: true }),
      applyChanges: async (_project, _owner, _changes, options) => {
        assert.equal(options.setupRepair, true)
        writes++
      },
    },
  })
  t.after(async () => {
    await manager.shutdown()
    events.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  for (const change of [
    { path: 'Main.lean', before: 'original', after: 'rewritten' },
    { path: 'lean-toolchain', before: pin, after: 'leanprover/lean4:v4.35.0' },
  ]) {
    const job = events.create('alice', {
      kind: 'agent',
      purpose: 'setup',
      projectId: 'p',
      changes: [change],
    })
    events.update(job.id, {
      status: 'completed',
      changes: [change],
      verification: { editsAllowed: true },
    })
    await assert.rejects(
      manager.apply('alice', job.id),
      (error) => error.status === 409 && /Setup help/.test(error.message),
    )
  }
  assert.equal(writes, 0)
  const allowed = events.create('alice', {
    kind: 'agent',
    purpose: 'setup',
    projectId: 'p',
    changes: [
      { path: 'lakefile.toml', before: 'broken', after: 'name = "repaired"\n' },
    ],
  })
  events.update(allowed.id, {
    status: 'completed',
    changes: [
      { path: 'lakefile.toml', before: 'broken', after: 'name = "repaired"\n' },
    ],
    verification: { editsAllowed: true },
  })
  assert.equal((await manager.apply('alice', allowed.id)).status, 'applied')
  assert.equal(writes, 1)
})
