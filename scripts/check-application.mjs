#!/usr/bin/env node
// Makes a real provider request and creates a separate verification project.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const projectDir = new URL('../', import.meta.url).pathname
const dataDir = process.env.STUDIO_DATA_DIR || projectDir + '.data'
const reportDir = projectDir + '.runtime'
await fs.mkdir(reportDir, { recursive: true })
const token = (await fs.readFile(dataDir + '/auth/owner.token', 'utf8')).trim()
const headers = {
  Authorization: 'Bearer ' + token,
  'Content-Type': 'application/json',
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`${r.status} ${d.error}`)
  return d
}
async function until(path, done, limit = 240000) {
  const start = Date.now()
  while (Date.now() - start < limit) {
    const d = await api(path)
    if (done(d)) return d
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('Timed out ' + path)
}
const session = await api('/api/session')
assert.equal(session.lemex.configured, true)
assert(session.templates.every((p) => p.ready))
const project = await api('/api/projects', {
  name: 'Lemex verification example',
  preset: 'lean',
})
console.log('Created proof verification project', project.id)
await until('/api/projects/' + project.id, (p) => p.status !== 'preparing')
const p = await api('/api/projects/' + project.id)
assert.equal(p.status, 'ready', p.error)
const before = await api('/api/projects/' + project.id + '/file?path=Main.lean')
const broken =
  'import Lean\n\ntheorem addition_commutes (a b : Nat) : a + b = b + a := by\n  exact Nat.add_assoc a b 0\n'
await api(
  '/api/projects/' + project.id + '/file?path=Main.lean',
  { content: broken, expectedHash: before.hash },
  'PUT',
)
const check = await api('/api/projects/' + project.id + '/check', {
  path: 'Main.lean',
})
const checked = await until('/api/jobs/' + check.id, (j) =>
  ['completed', 'failed', 'cancelled'].includes(j.status),
)
assert.equal(checked.status, 'failed')
console.log('Broken proof rejected by real Lean')
const run = await api('/api/projects/' + project.id + '/runs', {
  mode: 'proofs',
  prompt:
    'Repair the proof in Main.lean. Keep the exact theorem statement and imports. Inspect the diagnostics or goal using the Lean MCP tools before fixing it. Run Lean to verify the repair. Return a concise explanation.',
  file: 'Main.lean',
  maxSeconds: null,
  liveEdits: false,
})
console.log('Started live Lemex run', run.id)
let last = ''
const result = await until(
  '/api/runs/' + run.id,
  (j) => {
    if (j.status !== last) {
      console.log('Run status', j.status)
      last = j.status
    }
    return ['completed', 'failed', 'cancelled', 'interrupted'].includes(
      j.status,
    )
  },
  600000,
).catch(async (error) => {
  await api('/api/runs/' + run.id + '/stop', {})
  throw error
})
await fs.writeFile(
  reportDir + '/application-verification.json',
  JSON.stringify(
    {
      projectId: project.id,
      run: result,
      session: {
        lemex: session.lemex,
        model: session.defaultModel,
        templates: session.templates.map((p) => ({
          id: p.id,
          toolchain: p.toolchain,
          ready: p.ready,
        })),
      },
    },
    null,
    2,
  ),
)
console.log({
  status: result.status,
  error: result.error,
  verification: result.verification,
  message: result.message,
  activity: result.log?.slice(-5000),
})
assert.equal(result.status, 'completed', result.error)
assert.equal(
  result.verification.complete,
  true,
  JSON.stringify(result.verification),
)
assert(result.changes.some((c) => c.path === 'Main.lean'))
assert.equal(result.verification.kernelChecked, true)
if (process.env.STUDIO_TEST_REVIEW_ONLY === '1') {
  console.log('Candidate ready for browser review', run.id)
  process.exit(0)
}
const applied = await api('/api/runs/' + run.id + '/apply', {})
assert.equal(applied.status, 'applied')
const finalCheck = await api('/api/projects/' + project.id + '/check', {
  path: 'Main.lean',
})
const final = await until('/api/jobs/' + finalCheck.id, (j) =>
  ['completed', 'failed', 'cancelled'].includes(j.status),
)
assert.equal(final.status, 'completed')
console.log('Accepted candidate and checked repaired proof', project.id)
await fs.writeFile(
  reportDir + '/application-verification.json',
  JSON.stringify(
    {
      projectId: project.id,
      run: applied,
      finalCheck: final,
      lemex: session.lemex,
      model: session.defaultModel,
    },
    null,
    2,
  ),
)
