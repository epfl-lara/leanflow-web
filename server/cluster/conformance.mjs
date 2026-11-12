import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Runtime } from '../runtime.mjs'
import { clusterError } from './state.mjs'
import { inspectBoundary } from './boundary.mjs'
import { hostAppArmorEnabled } from '../container-engine.mjs'

const execute = promisify(execFile)

export function kernelIsolationEvidence(output) {
  for (const line of output.split('\n')) {
    let text = line
    try {
      const message = JSON.parse(line)
      if (typeof message?.data === 'string') text = message.data
    } catch {
      /* Kernel-check progress is plain text. */
    }
    for (const candidate of text.split('\n')) {
      if (!candidate.startsWith('LEANFLOW_KERNEL_ISOLATION ')) continue
      try {
        const value = JSON.parse(
          candidate.slice('LEANFLOW_KERNEL_ISOLATION '.length),
        )
        if (value && typeof value === 'object' && !Array.isArray(value))
          return value
      } catch {
        /* A malformed marker cannot certify the sandbox. */
      }
    }
  }
  return null
}

async function verifyContainerParent(worker, child, boundary, scratchBytes) {
  let lastError
  for (let retry = 0; retry < 30; retry++) {
    try {
      const { stdout } = await execute(
        worker.config.engineExecutable,
        ['inspect', '--format', '{{json .}}', child.containerName],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      )
      const info = JSON.parse(stdout)
      if (
        info.HostConfig?.NetworkMode !== 'none' ||
        info.HostConfig.ReadonlyRootfs !== true ||
        info.HostConfig.Privileged === true ||
        !info.HostConfig.CapDrop?.includes('ALL')
      )
        throw new Error(
          'The outer sandbox is not offline, read-only and capability-free.',
        )
      const outer = await fs.readFile(`/proc/${info.State.Pid}/status`, 'utf8')
      if (
        !/^NoNewPrivs:\s+1$/m.test(outer) ||
        !/^Seccomp:\s+2$/m.test(outer) ||
        !/^CapEff:\s+0+$/m.test(outer)
      )
        throw new Error('The outer process confinement did not pass.')
      if (
        child.kernelCheck &&
        hostAppArmorEnabled() &&
        !(
          await fs.readFile(`/proc/${info.State.Pid}/attr/current`, 'utf8')
        ).startsWith('leanflow-kernel-check ')
      )
        throw new Error('The outer kernel-check AppArmor profile is missing.')
      if (
        info.HostConfig?.LogConfig?.Type !== 'none' ||
        info.Mounts?.some((mount) => mount.Type === 'bind' && mount.RW)
      )
        throw new Error(
          'Pure checks must not have disk logs or writable host binds.',
        )
      const temporary = info.HostConfig?.Tmpfs || {}
      let allocated = 0
      for (const [name, options] of Object.entries(temporary)) {
        if (
          !['/tmp', '/home/worker', '/workspace/.lake', '/run/user'].includes(
            name,
          )
        )
          throw new Error('Unexpected writable tmpfs.')
        const size = /(?:^|,)size=(\d+)(m?)(?:,|$)/.exec(options)
        if (!size) throw new Error('Unbounded tmpfs.')
        allocated += Number(size[1]) * (size[2] === 'm' ? 1024 ** 2 : 1)
      }
      if (
        allocated > scratchBytes + 16 * 1024 ** 2 ||
        ['/tmp', '/home/worker', '/workspace/.lake'].some(
          (name) => !temporary[name],
        )
      )
        throw new Error('Writable tmpfs limits do not match the scratch grant.')
      if (
        info.HostConfig?.CgroupParent !== worker.config.cgroupParent ||
        !Number.isSafeInteger(info.State?.Pid) ||
        info.State.Pid < 1
      )
        throw new Error('Container is not running in its enrolled slice.')
      const membership = await fs.readFile(
        `/proc/${info.State.Pid}/cgroup`,
        'utf8',
      )
      const relative = membership
        .split('\n')
        .find((line) => line.startsWith('0::'))
        ?.slice(3)
      if (!relative?.startsWith('/' + boundary.relative + '/'))
        throw new Error('Container is outside its enforced slice.')
      return true
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw Object.assign(
    clusterError(
      'Actual container placement did not match its bounded system slice.',
      'conformance_failed',
      503,
    ),
    { detail: lastError?.message },
  )
}

// This function is executed by the enrolled node, never populated by a caller's
// claimed booleans. Failed classes are omitted instead of weakening the sandbox.
export async function certifyWorker(worker, value = {}) {
  const version = value.toolchain
  if (typeof version !== 'string' || !worker.runtime.toolchains.has(version))
    throw clusterError(
      'Prepare the pinned conformance toolchain first.',
      'assets_missing',
      409,
    )
  const directory = path.join(
    worker.config.dataDir,
    'conformance',
    randomUUID(),
  )
  const root = path.join(directory, 'project')
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const runtime = new Runtime({
    dataDir: directory,
    image: worker.config.image,
    engineKind: worker.config.engineKind,
    docker: worker.config.engineExecutable,
    memory: '96m',
    memoryBudget: '288m',
    cpus: 1,
    maxConcurrent: 3,
    scope: 'conformance',
    cgroupParent: worker.config.cgroupParent,
    hostToolchainDir: path.join(
      worker.config.dataDir,
      'runtime/elan/toolchains',
    ),
  })
  const report = {
    version: 1,
    nodeId: worker.config.nodeId,
    nodeEpoch: worker.nodeEpoch,
    bundleDigest: worker.bundleDigest,
    imageDigest: worker.config.image,
    engineKind: worker.config.engineKind,
    checkedAt: new Date().toISOString(),
    capabilities: [],
    checks: {},
    failures: {},
  }
  try {
    const boundary = await inspectBoundary(worker.config)
    report.checks.containerParent = boundary
    const info = await runtime.init()
    if (
      !info.ready ||
      info.cgroupDriver !== 'systemd' ||
      info.cgroupVersion !== '2'
    )
      throw clusterError(
        'The worker image and enforced resource limits must be available before certification.',
        'engine_unavailable',
        503,
      )
    runtime.toolchains.set(version, worker.runtime.toolchains.get(version))
    const environment = path.join(directory, 'environment')
    await fs.mkdir(path.join(environment, '.lake/packages'), {
      recursive: true,
      mode: 0o700,
    })
    await fs.writeFile(
      path.join(environment, '.lake/packages/dependency.guard'),
      'protected',
    )
    await runtime.inheritDependencies(environment, root)
    const script = String.raw`
import ctypes,errno,json,os,socket,time
from pathlib import Path
c=Path('/sys/fs/cgroup')
assert int((c/'memory.max').read_text())==96*1024**2
assert int((c/'memory.swap.max').read_text())==0
quota,period=map(int,(c/'cpu.max').read_text().split())
assert quota==period
assert int((c/'pids.max').read_text())==512
assert os.getuid()!=0
status=Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\t1' in status
assert 'Seccomp:\t2' in status
assert int(next(x.split(':',1)[1].strip() for x in status.splitlines() if x.startswith('CapEff:')),16)==0
try:
 Path('/host-escape').write_text('denied')
 raise AssertionError('root is writable')
except OSError:pass
try:
 Path('/workspace/source.guard').write_text('changed')
 raise AssertionError('source is writable')
except OSError:pass
assert Path('/workspace/.lake/packages/dependency.guard').read_text()=='protected'
try:
 Path('/workspace/.lake/packages/dependency.guard').write_text('changed')
 raise AssertionError('shared dependencies are writable')
except OSError:pass
Path('/workspace/.lake/ownership-probe').write_text('private-cache')
for directory,limit in [('/home/worker',4*1024**2),('/workspace/.lake',4*1024**2),('/tmp',8*1024**2)]:
 mount=next(line.split(' - ',1)[1].split()[0] for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4]==directory)
 assert mount=='tmpfs'
 target=Path(directory)/'scratch-overflow'
 try:
  with target.open('wb') as output:
   for _ in range(limit//(1024**2)+1):output.write(b'x'*(1024**2))
  raise AssertionError('scratch limit is not enforced')
 except OSError as error:assert error.errno==errno.ENOSPC
 finally:target.unlink(missing_ok=True)
assert not Path('/var/run/docker.sock').exists()
assert not Path('/home/milikic').exists()
assert not Path('/home/lemex').exists()
assert socket.if_nameindex()==[(1,'lo')]
assert ctypes.CDLL(None,use_errno=True).unshare(0x10000000)!=0
print(json.dumps(dict(uid=os.getuid(),cacheUid=Path('/workspace/.lake/ownership-probe').stat().st_uid,memory=96*1024**2,swap=0,cpus=1,pids=512,scratch='bounded-tmpfs')))
time.sleep(4)
`
    await fs.writeFile(path.join(root, 'source.guard'), 'protected')
    let parentCheck
    const enforced = await runtime.run(root, ['python3', '-I', '-c', script], {
      network: 'none',
      timeoutMs: 30000,
      readOnlyWorkspace: true,
      writeLakeCache: true,
      freshHome: true,
      cleanHome: true,
      boundedScratchBytes: 16 * 1024 ** 2,
      onSpawn: (child) => {
        parentCheck = verifyContainerParent(
          worker,
          child,
          boundary,
          16 * 1024 ** 2,
        )
        parentCheck.catch(() => {})
      },
    })
    await parentCheck
    if (enforced.code !== 0)
      throw Object.assign(
        clusterError(
          'The worker isolation/resource probe did not pass.',
          'conformance_failed',
          503,
        ),
        { probe: enforced },
      )
    report.checks.resourcesAndIsolation = JSON.parse(enforced.stdout)
    if (report.checks.resourcesAndIsolation.uid !== process.getuid())
      throw clusterError(
        'Worker files do not map to the dedicated service account.',
        'conformance_failed',
        503,
      )
    if (report.checks.resourcesAndIsolation.cacheUid !== process.getuid())
      throw clusterError(
        'Writable cache ownership does not match the service account.',
        'conformance_failed',
        503,
      )
    const [overflow, sibling] = await Promise.all([
      runtime.run(
        root,
        [
          'python3',
          '-I',
          '-c',
          'a=bytearray(256*1024**2); print("unexpected")',
        ],
        {
          network: 'none',
          timeoutMs: 30000,
          readOnlyWorkspace: true,
          writeLakeCache: true,
          freshHome: true,
          cleanHome: true,
          boundedScratchBytes: 16 * 1024 ** 2,
        },
      ),
      runtime.run(
        root,
        [
          'python3',
          '-I',
          '-c',
          'import time; time.sleep(2); print("sibling-alive")',
        ],
        {
          network: 'none',
          timeoutMs: 30000,
          readOnlyWorkspace: true,
          writeLakeCache: true,
          freshHome: true,
          cleanHome: true,
          boundedScratchBytes: 16 * 1024 ** 2,
        },
      ),
    ])
    if (overflow.code !== 137)
      throw clusterError(
        'Memory overflow did not stay inside its sandbox.',
        'conformance_failed',
        503,
      )
    if (sibling.code !== 0 || sibling.stdout.trim() !== 'sibling-alive')
      throw clusterError(
        'An isolated OOM disrupted another worker.',
        'conformance_failed',
        503,
      )
    const recovery = await runtime.run(
      root,
      ['python3', '-I', '-c', 'print("recovered")'],
      {
        network: 'none',
        timeoutMs: 30000,
        readOnlyWorkspace: true,
        writeLakeCache: true,
        freshHome: true,
        cleanHome: true,
        boundedScratchBytes: 16 * 1024 ** 2,
      },
    )
    if (recovery.code !== 0 || recovery.stdout.trim() !== 'recovered')
      throw clusterError(
        'Worker recovery after isolated OOM failed.',
        'conformance_failed',
        503,
      )
    report.checks.isolatedOomAndRecovery = true
    await runtime.shutdown()
    const leanRuntime = new Runtime({
      dataDir: directory,
      image: worker.config.image,
      engineKind: worker.config.engineKind,
      docker: worker.config.engineExecutable,
      memory: worker.config.workerMemory,
      memoryBudget: worker.config.memoryBudget,
      cpus: worker.config.workerCpus,
      maxConcurrent: 3,
      scope: 'conformance',
      cgroupParent: worker.config.cgroupParent,
      hostToolchainDir: path.join(
        worker.config.dataDir,
        'runtime/elan/toolchains',
      ),
    })
    try {
      if (!(await leanRuntime.init()).ready)
        throw clusterError(
          'Pinned Lean probe runtime is unavailable.',
          'conformance_failed',
          503,
        )
      leanRuntime.toolchains.set(
        version,
        worker.runtime.toolchains.get(version),
      )
      await fs.writeFile(path.join(root, 'lean-toolchain'), version + '\n')
      await fs.writeFile(
        path.join(root, 'lakefile.toml'),
        'name = "cluster_conformance"\nversion = "0.0.0"\ndefaultTargets = ["ClusterConformance"]\n\n[[lean_lib]]\nname = "ClusterConformance"\n',
      )
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        JSON.stringify({
          version: '1.1.0',
          packagesDir: '.lake/packages',
          packages: [],
          name: 'cluster_conformance',
          lakeDir: '.lake',
        }),
      )
      await fs.writeFile(
        path.join(root, 'ClusterConformance.lean'),
        'theorem cluster_conformance : True := by trivial\n',
      )
      await fs.writeFile(
        path.join(root, 'Invalid.lean'),
        'example : False := by trivial\n',
      )
      const options = {
        network: 'none',
        timeoutMs: 180000,
        readOnlyWorkspace: true,
        writeLakeCache: true,
        freshHome: true,
        cleanHome: true,
        boundedScratchBytes: 16 * 1024 ** 3,
        signal: worker.shutdownController?.signal,
      }
      const valid = await leanRuntime.run(root, ['lake', 'build'], options)
      const binary = await leanRuntime.run(
        root,
        ['lake', 'env', 'lean', '--version'],
        options,
      )
      const invalid = await leanRuntime.run(
        root,
        ['lake', 'env', 'lean', 'Invalid.lean'],
        options,
      )
      if (
        valid.code !== 0 ||
        invalid.code === 0 ||
        binary.code !== 0 ||
        /\bversion\s+([^,\s)]+)/.exec(binary.stdout)?.[1] !==
          version.split(':v')[1]
      )
        throw Object.assign(
          clusterError(
            'Pinned Lean valid/invalid checks did not agree.',
            'conformance_failed',
            503,
          ),
          { probe: { valid, invalid, binary } },
        )
      report.capabilities.push('check.build', 'lean.file')
      report.checks.pinnedLean = {
        version,
        valid: valid.code,
        invalid: invalid.code,
        binary: binary.stdout.trim(),
      }
      if (await leanRuntime.leanCheckSupported(root)) {
        const kernelScript = String.raw`
import json,os,socket,time
from pathlib import Path
status=Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\t1' in status and 'Seccomp:\t2' in status
assert int(next(x.split(':',1)[1].strip() for x in status.splitlines() if x.startswith('CapEff:')),16)==0
assert socket.if_nameindex()==[(1,'lo')]
for name in ['/proc/sysrq-trigger','/proc/sys/kernel/randomize_va_space']:
 try:
  fd=os.open(name,os.O_WRONLY);os.close(fd)
  raise AssertionError('kernel control is writable')
 except OSError:pass
assert next(line.split()[5] for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4]=='/sys').split(',')[0]=='ro'
label=Path('/proc/self/attr/current').read_text().strip()
${hostAppArmorEnabled() ? "assert label.startswith('leanflow-kernel-check ')" : ''}
for directory in ['/tmp','/home/worker','/workspace/.lake']:
 assert next(line.split(' - ',1)[1].split()[0] for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4]==directory)=='tmpfs'
print(json.dumps(dict(label=label,network='none',capabilities=0,scratch='bounded-tmpfs')))
time.sleep(4)
`
        await fs.writeFile(
          path.join(root, 'KernelIsolation.lean'),
          `#eval do\n  let result ← IO.Process.output { cmd := "python3", args := #["-I", "-c", ${JSON.stringify(kernelScript)}] }\n  if result.exitCode != 0 then throw (IO.userError result.stderr)\n  IO.println ("LEANFLOW_KERNEL_ISOLATION " ++ result.stdout)\n\ntheorem cluster_conformance : True := by trivial\n`,
        )
        let kernelParent
        const checked = await leanRuntime.checkProject(root, {
          ...options,
          timeoutMs: 300000,
          postCheckFile: 'KernelIsolation.lean',
          onSpawn: (child) => {
            kernelParent = verifyContainerParent(
              worker,
              child,
              boundary,
              options.boundedScratchBytes,
            )
            kernelParent.catch(() => {})
          },
        })
        let kernelMountError
        const kernelMounts = await kernelParent.then(
          () => true,
          (error) => {
            kernelMountError = error.detail || error.message
            return false
          },
        )
        const probe = kernelIsolationEvidence(
          checked.stdout + '\n' + checked.stderr,
        )
        if (checked.code === 0 && kernelMounts && probe) {
          report.capabilities.push('check.kernel')
          report.checks.nativeKernel = true
          report.checks.kernelIsolation = probe
        } else
          report.failures.nativeKernel =
            'Native checker or its isolation probe did not pass: ' +
            JSON.stringify({
              code: checked.code,
              kernelMounts,
              kernelMountError,
              marker: !!probe,
            }) +
            (checked.stderr + checked.stdout).slice(-1500)
      }
    } finally {
      await leanRuntime.shutdown()
    }
    return report
  } finally {
    await runtime.shutdown()
    await fs.rm(directory, { recursive: true, force: true })
  }
}
