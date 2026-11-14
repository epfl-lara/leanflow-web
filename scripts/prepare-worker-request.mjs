#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  readControllerConfig,
  controllerConfig,
  nodeConfig,
  workerBundleDigest,
} from '../server/cluster/config.mjs'

const execute = promisify(execFile)
const GiB = 1024 ** 3
export const workerAllocations = {
  standard: {
    cpus: 8,
    memory: 24,
    slots: 4,
    outerCpus: 16,
    outerMemory: 48,
    tasks: 8192,
  },
  limited: {
    cpus: 6,
    memory: 18,
    slots: 3,
    outerCpus: 8,
    outerMemory: 24,
    tasks: 4096,
  },
}

function publicKey(text) {
  assert(
    ['\r', '\n', '\0'].every((char) => !text.trim().includes(char)),
    'Supply one Ed25519 public key.',
  )
  const [type, encoded] = text.trim().split(/\s+/)
  const bytes = Buffer.from(encoded || '', 'base64')
  assert.equal(type, 'ssh-ed25519')
  assert.equal(bytes.length, 51)
  assert.equal(bytes.readUInt32BE(0), 11)
  assert.equal(bytes.subarray(4, 15).toString(), 'ssh-ed25519')
  assert.equal(bytes.readUInt32BE(15), 32)
  assert.equal(bytes.toString('base64'), encoded)
  return `${type} ${encoded}`
}

function absolute(filename) {
  assert(path.isAbsolute(filename) && path.normalize(filename) === filename)
  assert(
    /^[A-Za-z0-9_./-]+$/.test(filename),
    'Use an absolute path without shell metacharacters.',
  )
  return filename
}

async function reviewedWorkerArchive(options, profile) {
  const archive = path.resolve(options.archive)
  const stat = await fs.lstat(archive)
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= 32 * 1024 ** 2,
  )
  const archiveBytes = await fs.readFile(archive)
  const archiveDigest = createHash('sha256').update(archiveBytes).digest('hex')
  assert.equal(
    archiveDigest,
    options['archive-sha256'],
    'Worker archive checksum differs from the reviewed export.',
  )
  const member = async (name) =>
    (
      await execute('tar', ['-xOzf', archive, './' + name], {
        maxBuffer: 2 * 1024 ** 2,
      })
    ).stdout
  const manifest = JSON.parse(await member('worker-release.json'))
  assert.equal(
    manifest.bundleDigest,
    profile.bundleDigest,
    'Archive does not match the live worker profile.',
  )
  assert.equal(manifest.dirty, false)
  assert(/^[a-f0-9]{40}$/.test(manifest.sourceRevision))
  assert(Array.isArray(manifest.files))
  // Read archive bytes, never execute or extract its code. Reject links,
  // undeclared files and unsafe paths before materializing a private copy.
  const listing = (await execute('tar', ['-tzf', archive])).stdout
    .trim()
    .split('\n')
  const verbose = (await execute('tar', ['-tvzf', archive])).stdout
    .trim()
    .split('\n')
  assert(
    verbose.every((line) => /^[d-]/.test(line)),
    'Worker archives must contain only directories and regular files.',
  )
  const normalize = (name) => name.replace(/^\.\//, '')
  for (const entry of listing) {
    const name = normalize(entry).replace(/\/$/, '')
    if (!name || name === '.') continue
    assert(
      /^(?:(?:server|shared|deploy)(?:\/[A-Za-z0-9_./-]+)?|worker-release\.json)$/.test(
        name,
      ),
    )
    assert(
      name.split('/').every((part) => part && part !== '.' && part !== '..'),
    )
  }
  const archivedFiles = listing
    .filter((name) => !name.endsWith('/'))
    .map(normalize)
  assert.equal(
    new Set(archivedFiles).size,
    archivedFiles.length,
    'Duplicate archive entries.',
  )
  assert.deepEqual(
    [...archivedFiles].sort(),
    ['worker-release.json', ...manifest.files.map((file) => file.path)].sort(),
  )
  const rows = new Map(manifest.files.map((row) => [row.path, row]))
  for (const row of manifest.files) {
    assert(/^(server|shared|deploy)\/[A-Za-z0-9_./-]+$/.test(row.path))
    assert(
      row.path
        .split('/')
        .every((part) => part && part !== '.' && part !== '..'),
    )
    assert(Number.isSafeInteger(row.size) && row.size >= 0)
  }
  const selected = listing.filter((name) => rows.has(normalize(name)))
  const expectedSize = manifest.files.reduce((sum, row) => sum + row.size, 0)
  assert(expectedSize <= 128 * 1024 ** 2 && selected.length <= 2048)
  const payload = (
    await execute('tar', ['-xOzf', archive, ...selected], {
      encoding: 'buffer',
      maxBuffer: 128 * 1024 ** 2,
    })
  ).stdout
  assert.equal(payload.length, expectedSize)
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-reviewed-worker-'),
  )
  try {
    let offset = 0
    for (const entry of selected) {
      const row = rows.get(normalize(entry)),
        bytes = payload.subarray(offset, offset + row.size)
      offset += row.size
      assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256)
      const filename = path.join(temporary, row.path)
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
      await fs.writeFile(filename, bytes, { mode: 0o600, flag: 'wx' })
    }
    assert.equal(
      await workerBundleDigest(temporary),
      profile.bundleDigest,
      'Actual source bytes differ from the enrolled worker bundle.',
    )
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
  const verifiedMember = async (name) => {
    const text = await member(name)
    const row = manifest.files.find((file) => file.path === name)
    assert.equal(
      createHash('sha256').update(text).digest('hex'),
      row?.sha256,
      'Archive member differs from its manifest.',
    )
    return text
  }
  const userService = await verifiedMember('deploy/leanflow-node-user.service')
  const apparmor = await verifiedMember('deploy/leanflow-kernel-check.apparmor')
  return { archiveBytes, archiveDigest, manifest, userService, apparmor }
}

export async function prepareWorkerRequest(options) {
  const controller = await readControllerConfig(
    absolute(options['controller-config']),
  )
  const profile = controller.executionProfile
  assert(
    profile,
    'Use the currently enrolled execution profile, not a new worker build.',
  )
  const allocation = workerAllocations[options.allocation]
  assert(allocation, 'Select standard or limited allocation.')
  const home = absolute(options.home)
  assert(home !== '/', 'A worker needs its own local account home.')
  const identityFile = absolute(options['coordinator-key'])
  const knownHostsFile = absolute(options['coordinator-known-hosts'])
  const entry = {
    id: options.node,
    host: options.host,
    user: 'leanflow',
    identityFile,
    knownHostsFile,
    role: 'primary',
    enabled: false,
  }
  controllerConfig({
    ...controller,
    nodes: [...controller.nodes.filter((n) => n.id !== entry.id), entry],
  })
  const key = publicKey(await fs.readFile(options['public-key'], 'utf8'))
  const bootstrap = publicKey(
    await fs.readFile(options['bootstrap-key'], 'utf8'),
  )
  const hostKey = publicKey(await fs.readFile(options['host-key'], 'utf8'))
  assert.notEqual(
    key,
    bootstrap,
    'Keep protocol and temporary maintenance credentials separate.',
  )
  const expiry = options['bootstrap-expires']
  assert(
    /^\d{14}Z$/.test(expiry),
    'Use a UTC YYYYMMDDHHMMSSZ bootstrap expiry.',
  )
  const timestamp = Date.parse(
    `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}T${expiry.slice(8, 10)}:${expiry.slice(10, 12)}:${expiry.slice(12, 14)}Z`,
  )
  assert(
    Number.isFinite(timestamp) &&
      new Date(timestamp)
        .toISOString()
        .replace(/[-:T]/g, '')
        .replace('.000', '') === expiry,
    'Invalid bootstrap expiry date.',
  )
  assert(
    timestamp > Date.now() && timestamp - Date.now() <= 8 * 86400000,
    'Bootstrap keys must expire within eight days.',
  )
  const { archiveBytes, archiveDigest, manifest, userService, apparmor } =
    await reviewedWorkerArchive(options, profile)
  const config = {
    version: 1,
    nodeId: entry.id,
    controllerLineage: controller.lineage,
    dataDir: home + '/leanflow/state',
    socketPath: home + '/leanflow/state/worker.sock',
    image: profile.imageDigest,
    engineKind: 'docker',
    engineExecutable: '/usr/bin/docker',
    cgroupParent: 'leanflow-workers.slice',
    parentMemoryMax: allocation.outerMemory + 'g',
    parentTasksMax: allocation.tasks,
    parentMaxCpus: allocation.outerCpus,
    workerMemory: '6g',
    workerCpus: 2,
    memoryBudget: allocation.memory + 'g',
    maxCpus: allocation.cpus,
    maxConcurrent: allocation.slots,
    scratchBytes: allocation.slots * 16 * GiB,
    maxStoreBytes: 64 * GiB,
    maxStoreFiles: 500000,
    reserveBytes: 64 * GiB,
    leaseMs: 30000,
    role: 'primary',
    startUserService: true,
    certifyToolchain: 'leanprover/lean4:v4.35.0',
  }
  nodeConfig(config)
  const bridge = [
    '#!/bin/sh',
    'set -eu',
    'worker_uid=$(/usr/bin/id -u)',
    'worker_home=$(/usr/bin/getent passwd "$worker_uid" | /usr/bin/cut -d: -f6)',
    'case "$worker_home" in /*) ;; *) exit 64 ;; esac',
    'exec /usr/bin/env -i HOME="$worker_home" PATH=/opt/node/bin:/usr/bin:/bin \\',
    '  XDG_RUNTIME_DIR="/run/user/$worker_uid" \\',
    '  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$worker_uid/bus" \\',
    '  SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND-}" \\',
    '  /opt/node/bin/node "$worker_home/leanflow/app/current/server/cluster/node.mjs" \\',
    '  bridge --config "$worker_home/leanflow/node.json"',
    '',
  ].join('\n')
  const files = {
    'node.json': JSON.stringify(config, null, 2) + '\n',
    'controller-entry.json': JSON.stringify(entry, null, 2) + '\n',
    'execution-profile.json': JSON.stringify(profile, null, 2) + '\n',
    known_hosts: `${entry.host} ${hostKey}\n`,
    'worker-bridge': bridge,
    'leanflow-node.service': userService,
    'leanflow-kernel-check': apparmor,
    'leanflow-workers.slice': `[Unit]\nDescription=LeanFlow container resource boundary\n\n[Slice]\nCPUAccounting=yes\nCPUQuota=${allocation.outerCpus * 100}%\nMemoryAccounting=yes\nMemoryMax=${allocation.outerMemory}G\nMemorySwapMax=0\nTasksAccounting=yes\nTasksMax=${allocation.tasks}\n\n[Install]\nWantedBy=slices.target\n`,
    'protocol.authorized_keys': `restrict,command="${home}/leanflow/bin/worker-bridge" ${key} leanflow-${entry.id}-protocol\n`,
    'bootstrap.authorized_keys': `restrict,expiry-time="${expiry}" ${bootstrap} leanflow-${entry.id}-temporary-bootstrap\n`,
    'worker-source.tar.gz': archiveBytes,
    'request.json':
      JSON.stringify(
        {
          node: entry.id,
          allocation: options.allocation,
          role: 'primary',
          enabled: false,
          sourceRevision: manifest.sourceRevision,
          executionProfile: profile,
          archiveDigest,
          bootstrapExpiresUTC: new Date(timestamp).toISOString(),
          ordinaryJobs: allocation.slots,
          nativeJobs: 1,
          applicationBoundsOnly: true,
          filesystemQuotaProvided: false,
        },
        null,
        2,
      ) + '\n',
  }
  const output = path.resolve(options.output)
  await fs.mkdir(output, { mode: 0o700 }) // Refuse to overwrite an earlier handoff.
  for (const [name, bytes] of Object.entries(files))
    await fs.writeFile(path.join(output, name), bytes, {
      mode: name === 'worker-bridge' ? 0o700 : 0o600,
      flag: 'wx',
    })
  await fs.writeFile(
    path.join(output, 'SHA256SUMS'),
    Object.entries(files)
      .map(
        ([name, bytes]) =>
          createHash('sha256').update(bytes).digest('hex') + '  ' + name,
      )
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  )
  return {
    output,
    node: entry.id,
    allocation: options.allocation,
    role: 'primary',
    enabled: false,
    archiveDigest,
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const flags = [
    'controller-config',
    'node',
    'host',
    'allocation',
    'home',
    'coordinator-key',
    'coordinator-known-hosts',
    'public-key',
    'bootstrap-key',
    'bootstrap-expires',
    'host-key',
    'archive',
    'archive-sha256',
    'output',
  ]
  const { values } = parseArgs({
    options: Object.fromEntries(
      flags.map((name) => [name, { type: 'string' }]),
    ),
  })
  for (const flag of flags) assert(values[flag], 'Missing --' + flag)
  console.log(JSON.stringify(await prepareWorkerRequest(values)))
}
