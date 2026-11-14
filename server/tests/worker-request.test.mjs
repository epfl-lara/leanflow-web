import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareWorkerRequest } from '../../scripts/prepare-worker-request.mjs'
import { workerBundleDigest, readNodeConfig } from '../cluster/config.mjs'
import { chooseNode } from '../cluster/state.mjs'

const execute = promisify(execFile),
  GiB = 1024 ** 3
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function sshPublic() {
  const raw = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .subarray(-32)
  const type = Buffer.from('ssh-ed25519'),
    first = Buffer.alloc(4),
    second = Buffer.alloc(4)
  first.writeUInt32BE(type.length)
  second.writeUInt32BE(raw.length)
  return (
    'ssh-ed25519 ' +
    Buffer.concat([first, type, second, raw]).toString('base64') +
    ' fixture\n'
  )
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-worker-request-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const files = {
    'server/fixture.mjs': 'export const fixture = true\n',
    'shared/fixture.json': '{}\n',
    'deploy/leanflow-node-user.service':
      '[Service]\nExecStart=/opt/node/bin/node /fixture\n',
    'deploy/leanflow-kernel-check.apparmor':
      'profile leanflow-kernel-check {}\n',
  }
  for (const [name, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true })
    await fs.writeFile(path.join(source, name), value)
  }
  const manifest = {
    version: 1,
    sourceRevision: '1'.repeat(40),
    dirty: false,
    bundleDigest: await workerBundleDigest(source),
    files: Object.entries(files).map(([name, value]) => ({
      path: name,
      size: Buffer.byteLength(value),
      sha256: hash(value),
    })),
  }
  await fs.writeFile(
    path.join(source, 'worker-release.json'),
    JSON.stringify(manifest),
  )
  const controller = path.join(root, 'controller.json')
  await fs.writeFile(
    controller,
    JSON.stringify({
      version: 1,
      lineage: 'existing-lineage',
      mode: 'serve',
      nodes: [],
      executionProfile: {
        version: 2,
        bundleDigest: manifest.bundleDigest,
        imageDigest: 'sha256:' + '2'.repeat(64),
      },
    }),
    { mode: 0o600 },
  )
  for (const name of ['protocol', 'bootstrap', 'host'])
    await fs.writeFile(path.join(root, name + '.pub'), sshPublic())
  const options = {
    'controller-config': controller,
    node: 'worker-new',
    host: 'worker.example.org',
    allocation: 'limited',
    home: '/localhome/leanflow',
    'coordinator-key': '/private/keys/worker-new',
    'coordinator-known-hosts': '/private/pins/worker-new',
    'public-key': path.join(root, 'protocol.pub'),
    'bootstrap-key': path.join(root, 'bootstrap.pub'),
    'host-key': path.join(root, 'host.pub'),
    'bootstrap-expires':
      new Date(Date.now() + 86400000)
        .toISOString()
        .replace(/\D/g, '')
        .slice(0, 14) + 'Z',
    archive: path.join(root, 'worker.tar.gz'),
    output: path.join(root, 'request'),
  }
  async function repack() {
    await execute(
      'tar',
      ['--no-xattrs', '-czf', options.archive, '-C', source, '.'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
    )
    options['archive-sha256'] = hash(await fs.readFile(options.archive))
  }
  await repack()
  return { root, source, options, manifest, repack }
}

test('handoff preserves live configuration, pins source, separates keys and stages a disabled primary', async (t) => {
  const { options } = await fixture(t)
  const before = await fs.readFile(options['controller-config'])
  await prepareWorkerRequest(options)
  assert.deepEqual(await fs.readFile(options['controller-config']), before)
  const read = (name) => fs.readFile(path.join(options.output, name), 'utf8')
  const node = await readNodeConfig(path.join(options.output, 'node.json'))
  const entry = JSON.parse(await read('controller-entry.json'))
  assert.equal(node.role, 'primary')
  assert.equal(entry.role, 'primary')
  assert.equal(entry.enabled, false)
  assert.equal(node.controllerLineage, 'existing-lineage')
  assert.equal(node.maxCpus, 6)
  assert.equal(node.budgetBytes, 18 * GiB)
  assert.match(
    await read('protocol.authorized_keys'),
    /^restrict,command="\/localhome\/leanflow\/leanflow\/bin\/worker-bridge" /,
  )
  assert.match(
    await read('bootstrap.authorized_keys'),
    /^restrict,expiry-time="\d{14}Z" /,
  )
  assert(!(await read('bootstrap.authorized_keys')).includes('command='))
  assert.match(await read('leanflow-workers.slice'), /CPUQuota=800%/)
  assert.match(await read('leanflow-workers.slice'), /MemoryMax=24G/)
  assert.equal((await fs.stat(options.output)).mode & 0o077, 0)
  for (const line of (await read('SHA256SUMS')).trim().split('\n')) {
    const [digest, name] = line.split('  ')
    assert.equal(
      hash(await fs.readFile(path.join(options.output, name))),
      digest,
    )
    assert.equal(
      (await fs.stat(path.join(options.output, name))).mode & 0o077,
      0,
    )
  }
  await assert.rejects(prepareWorkerRequest(options), { code: 'EEXIST' })
})

test('both allocations admit a native check and enforce their ordinary and native concurrency budgets', async (t) => {
  const { options } = await fixture(t)
  for (const allocation of ['standard', 'limited']) {
    const output = options.output + '-' + allocation
    await prepareWorkerRequest({ ...options, allocation, output })
    const c = await readNodeConfig(path.join(output, 'node.json'))
    const node = {
      id: c.nodeId,
      status: 'ready',
      role: c.role,
      capabilities: ['check.build', 'check.kernel'],
      bundleDigest: 'a'.repeat(64),
      imageDigest: c.image,
      lastSeen: 10000,
      budget: {
        memoryBytes: c.budgetBytes,
        cpus: c.maxCpus,
        scratchBytes: c.scratchBytes,
      },
    }
    const request = {
      operation: 'check.build',
      bundleDigest: node.bundleDigest,
      imageDigest: node.imageDigest,
      resources: { memoryBytes: 6 * GiB, cpus: 2, scratchBytes: 16 * GiB },
    }
    const active = []
    for (let i = 0; i < c.maxConcurrent; i++) {
      assert(chooseNode([node], request, active, { now: 10000 }))
      active.push({
        nodeId: node.id,
        operation: 'check.build',
        state: 'running',
        resources: request.resources,
      })
    }
    assert.equal(chooseNode([node], request, active, { now: 10000 }), null)
    const native = {
      ...request,
      operation: 'check.kernel',
      resources: { memoryBytes: 18 * GiB, cpus: 6, scratchBytes: 16 * GiB },
    }
    assert(chooseNode([node], native, [], { now: 10000 }))
    const running = [
      {
        nodeId: node.id,
        operation: 'check.kernel',
        state: 'running',
        resources: native.resources,
      },
    ]
    assert.equal(chooseNode([node], native, running, { now: 10000 }), null)
    assert.equal(
      Boolean(chooseNode([node], request, running, { now: 10000 })),
      allocation === 'standard',
    )
  }
})

test('tampered source fails even when its manifest and archive checksum are rewritten', async (t) => {
  const { options, source, manifest, repack } = await fixture(t)
  const value = 'export const tampered = true\n'
  await fs.writeFile(path.join(source, 'server/fixture.mjs'), value)
  const row = manifest.files.find((x) => x.path === 'server/fixture.mjs')
  row.size = Buffer.byteLength(value)
  row.sha256 = hash(value)
  await fs.writeFile(
    path.join(source, 'worker-release.json'),
    JSON.stringify(manifest),
  )
  await repack()
  await assert.rejects(
    prepareWorkerRequest(options),
    /Actual source bytes differ/,
  )
  await assert.rejects(fs.stat(options.output), { code: 'ENOENT' })
})

test('archive links and unknown members cannot enter a handoff', async (t) => {
  const { options, source, repack } = await fixture(t)
  await fs.symlink('/etc/passwd', path.join(source, 'deploy/escape'))
  await repack()
  await assert.rejects(
    prepareWorkerRequest(options),
    /only directories and regular files/,
  )
  await fs.unlink(path.join(source, 'deploy/escape'))
  await fs.writeFile(path.join(source, 'undeclared.txt'), 'not reviewed')
  await repack()
  await assert.rejects(prepareWorkerRequest(options))
})

test('bootstrap credentials expire soon, differ from protocol credentials and cannot inject options', async (t) => {
  const { options } = await fixture(t)
  await assert.rejects(
    prepareWorkerRequest({
      ...options,
      'bootstrap-expires': '20000101000000Z',
    }),
    /expire within/,
  )
  await assert.rejects(
    prepareWorkerRequest({
      ...options,
      'bootstrap-key': options['public-key'],
    }),
    /separate/,
  )
  await fs.writeFile(
    options['public-key'],
    sshPublic() + 'command="anything"\n',
  )
  await assert.rejects(prepareWorkerRequest(options), /one Ed25519/)
  await assert.rejects(fs.stat(options.output), { code: 'ENOENT' })
})
