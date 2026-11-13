import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import {
  compileLoadFixture,
  compileLoadWorkloads,
  loadTestSetting,
} from './lib/compile-load-fixture.mjs'

const {
  state: credentials,
  directory,
  origin,
  rounds,
} = await compileLoadFixture()
const data = await fs.realpath(loadTestSetting('STUDIO_LOAD_DATA_DIR'))
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname),
  'Run the API sampler beside the server; its administrator token must stay on loopback.',
)
const actors = new Set(credentials.accounts.map((a) => a.id))
assert.equal(actors.size, 10)
const owner = (
  await fs.readFile(path.join(data, 'auth/owner.token'), 'utf8')
).trim()
const release = await fs.realpath(loadTestSetting('STUDIO_LOAD_RELEASE'))
assert(/^[a-f0-9]{40}$/.test(path.basename(release)))
const { openSshRpc } = await import(
  pathToFileURL(path.join(release, 'server/cluster/controller.mjs'))
)
const config = JSON.parse(
  await fs.readFile(path.join(data, 'cluster/config.json'), 'utf8'),
)
const cluster = new DatabaseSync(
  path.join(data, 'cluster/cluster-controller.sqlite'),
  { readOnly: true },
)
const activity = new DatabaseSync(path.join(data, 'activity.sqlite'), {
  readOnly: true,
})
const identity = JSON.parse(
  cluster.prepare("SELECT value FROM cluster_meta WHERE key='controller'").get()
    .value,
)
assert.equal(config.mode, 'serve')
const selectedNode = config.nodes.find(
  (n) => n.id === loadTestSetting('STUDIO_LOAD_WORKER_ID') && n.enabled,
)
assert(selectedNode, 'Select an enrolled enabled worker.')
const rpc = openSshRpc(selectedNode, 'bulk')
const report = {
  passed: false,
  runTag: credentials.runTag,
  suppliedRelease: path.basename(release),
  users: 10,
  inferenceRequestedByHarness: false,
  inferenceCallsMeasured: false,
  workloads: [],
  rounds: [],
  samples: [],
  errors: [],
}
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
let sampling = false,
  sampleTask
async function api(
  token,
  endpoint,
  body,
  method = body === undefined ? 'GET' : 'POST',
  expected = 200,
) {
  const start = performance.now()
  const response = await fetch(origin + endpoint, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  })
  const value = await response.json()
  assert.equal(
    response.status,
    expected,
    `${method} ${endpoint}: ${response.status} ${value.error || ''}`,
  )
  return { value, latencyMs: Math.round(performance.now() - start) }
}
function attempts(jobIds) {
  if (!jobIds.size) return []
  return cluster
    .prepare(
      'SELECT id,job,node,state,payload FROM cluster_attempts WHERE job IN (' +
        [...jobIds].map(() => '?').join(',') +
        ')',
    )
    .all(...jobIds)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
}
async function sample() {
  const jobs = activity
    .prepare(
      'SELECT id,owner,payload FROM jobs WHERE owner IN (' +
        [...actors].map(() => '?').join(',') +
        ')',
    )
    .all(...actors)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
  const active = jobs.filter((j) => !terminal.has(j.payload.status))
  const status = await rpc.request('status', {})
  const { value: session, latencyMs } = await api(owner, '/api/session')
  const live = attempts(new Set(jobs.map((j) => j.id))).filter((a) =>
    [
      'assigned',
      'starting',
      'running',
      'validating',
      'stopping',
      'reconciling',
    ].includes(a.state),
  )
  report.samples.push({
    at: Date.now(),
    activeRequests: active.length,
    nativeAttempts: live.filter((a) => a.payload.operation === 'check.kernel')
      .length,
    workerRunning: status.running,
    vm: {
      active: session.runtime.active,
      queued: session.runtime.queued,
      workloads: session.runtime.workloads,
    },
    sessionLatencyMs: latencyMs,
  })
  const workerLimit = Math.min(
    Math.floor(status.budget.cpus / status.workerResources.cpus),
    Math.floor(status.budget.memoryBytes / status.workerResources.memoryBytes),
  )
  assert(status.running <= workerLimit)
  for (const node of config.nodes)
    assert(
      live.filter(
        (a) => a.node === node.id && a.payload.operation === 'check.kernel',
      ).length <= 1,
    )
}
async function round(label, kinds) {
  const record = {
    label,
    startedAt: Date.now(),
    cases: [],
    responseLatencyMs: [],
    passed: false,
  }
  report.rounds.push(record)
  console.log(
    'Starting ' + label + ': ten simultaneous authenticated compile requests',
  )
  const submissions = await Promise.all(
    credentials.accounts.map(async (account, index) => {
      const kind = kinds[index],
        project = account.projects[kind]
      const { value: job, latencyMs } = await api(
        account.token,
        '/api/projects/' + project.id + '/check',
        { path: kind === 'native' ? 'Workload.lean' : 'Main.lean' },
        'POST',
        202,
      )
      const result = {
        user: index + 1,
        userId: account.id,
        projectId: project.id,
        kind,
        jobId: job.id,
        submittedAt: Date.now(),
        submissionLatencyMs: latencyMs,
      }
      record.cases.push(result)
      return { account, result }
    }),
  )
  record.submissionSpreadMs =
    Math.max(...record.cases.map((c) => c.submittedAt)) -
    Math.min(...record.cases.map((c) => c.submittedAt))
  const deadline = Date.now() + 900000
  const pending = new Set(submissions)
  while (pending.size) {
    assert(Date.now() < deadline, 'Compile round timed out')
    for (const item of [...pending]) {
      const { value: job, latencyMs } = await api(
        item.account.token,
        '/api/jobs/' + item.result.jobId,
      )
      record.responseLatencyMs.push(latencyMs)
      if (terminal.has(job.status)) {
        Object.assign(item.result, {
          status: job.status,
          code: job.result?.code ?? null,
          error: job.error ?? null,
          checkMethod: job.checkMethod,
          elapsedMs: Date.now() - record.startedAt,
        })
        pending.delete(item)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const audit = JSON.parse(
    cluster
      .prepare("SELECT value FROM cluster_meta WHERE key='checkAudit'")
      .get()?.value || '[]',
  )
  const rows = attempts(new Set(record.cases.map((c) => c.jobId)))
  for (const c of record.cases) {
    c.audit = audit.findLast((a) => a.jobId === c.jobId) || null
    c.attempts = rows
      .filter((a) => a.job === c.jobId)
      .map((a) => ({
        id: a.id,
        node: a.node,
        state: a.state,
        operation: a.payload.operation,
        inputDigest: a.payload.inputDigest,
        sourceManifest: a.payload.sourceManifest,
        resources: a.payload.resources,
      }))
    assert.equal(c.status, 'completed', `User ${c.user} ${c.kind}: ${c.error}`)
    assert.equal(c.code, 0)
    if (c.kind === 'native') {
      assert.equal(c.audit?.reason, 'remote-completed')
      assert(
        c.attempts.some(
          (a) =>
            config.nodes.some((node) => node.id === a.node && node.enabled) &&
            a.operation === 'check.kernel' &&
            a.state === 'completed',
        ),
      )
    }
  }
  const nativeCases = record.cases.filter((c) => c.kind === 'native')
  assert.equal(
    new Set(nativeCases.map((c) => c.attempts[0].inputDigest)).size,
    nativeCases.length,
  )
  record.elapsedMs = Date.now() - record.startedAt
  record.passed = true
  console.log(
    JSON.stringify({
      label,
      passed: true,
      users: 10,
      elapsedMs: record.elapsedMs,
      submissionSpreadMs: record.submissionSpreadMs,
      statuses: record.cases.map((c) => ({
        user: c.user,
        kind: c.kind,
        status: c.status,
        elapsedMs: c.elapsedMs,
      })),
    }),
  )
  await fs.writeFile(
    path.join(directory, 'api-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  )
}
try {
  const status = await rpc.request('hello', {
    ...identity,
    version: 2,
    bundleDigest: config.executionProfile.bundleDigest,
    imageDigest: config.executionProfile.imageDigest,
  })
  assert(status.certified && status.capabilities.includes('check.kernel'))
  report.worker = {
    nodeId: status.nodeId,
    nodeEpoch: status.nodeEpoch,
    budget: status.budget,
    boundary: status.boundary,
    capabilities: status.capabilities,
  }
  report.capacity = (await api(owner, '/api/session')).value.capacity
  for (const account of credentials.accounts) {
    const session = (await api(account.token, '/api/session')).value
    assert.equal(session.user.id, account.id)
    assert.equal(session.user.role, 'user')
    assert.equal(session.user.name, account.name)
    for (const project of Object.values(account.projects)) {
      const actual = (await api(account.token, '/api/projects/' + project.id))
        .value
      assert.equal(actual.name, project.name)
    }
    const contents = {}
    for (const [name, kind, filename] of [
      ['native', 'native', 'Workload.lean'],
      ['toolchain', 'native', 'lean-toolchain'],
      ['mathlib', 'mathlib', 'Main.lean'],
    ])
      contents[name] = (
        await api(
          account.token,
          '/api/projects/' +
            account.projects[kind].id +
            '/file?path=' +
            filename,
        )
      ).value.content
    report.workloads.push(compileLoadWorkloads(account, contents))
    const foreign = credentials.accounts.find((a) => a.id !== account.id)
      .projects.native
    await api(
      account.token,
      '/api/projects/' + foreign.id + '/file?path=Workload.lean',
      undefined,
      'GET',
      404,
    )
  }
  sampling = true
  sampleTask = (async () => {
    while (sampling) {
      await sample()
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })()
  sampleTask.catch((error) => {
    report.errors.push('Sampling: ' + error.message)
    sampling = false
  })
  if (rounds === 'all' || rounds === 'native')
    await round('native-projects', Array(10).fill('native'))
  if (rounds === 'all' || rounds === 'mathlib')
    await round('mathlib-files', Array(10).fill('mathlib'))
  if (rounds === 'all' || rounds === 'mixed')
    await round(
      'mixed-projects-and-mathlib',
      Array.from({ length: 10 }, (_, i) => (i % 2 ? 'mathlib' : 'native')),
    )
  assert.equal(report.errors.length, 0)
  report.passed = true
} catch (error) {
  report.errors.push(error.message)
  process.exitCode = 1
} finally {
  sampling = false
  await sampleTask?.catch(() => {})
  // A sample already in flight can fail after the last round's success check.
  if (report.errors.length) {
    report.passed = false
    process.exitCode = 1
  }
  rpc.close()
  cluster.close()
  activity.close()
  report.finishedAt = Date.now()
  await fs.writeFile(
    path.join(directory, 'api-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      errors: report.errors,
      peakOutstandingRequests: Math.max(
        0,
        ...report.samples.map((s) => s.activeRequests),
      ),
      peakRemoteRunning: Math.max(
        0,
        ...report.samples.map((s) => s.workerRunning),
      ),
      peakLocalBatch: Math.max(
        0,
        ...report.samples.map((s) => s.vm.workloads.active.batch),
      ),
      peakLocalQueue: Math.max(0, ...report.samples.map((s) => s.vm.queued)),
    }),
  )
}
