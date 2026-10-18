#!/usr/bin/env node
// Real offline Docker regression; every source belongs to this disposable fixture.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'

const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || '.data')
const image = process.env.LEAN_PROBE_TEST_IMAGE || 'lemex-web-worker:local'
const runtime = new Runtime({ dataDir, image, scope: 'mount-pins-qa' })
const directory = path.join(dataDir, 'runtime/mount-pin-check', randomUUID())
const checkout = path.join(directory, 'checkout')
const root = path.join(checkout, 'a/b')
const reportDir = path.resolve(
  process.env.STUDIO_MOUNT_TEST_REPORT || '.runtime/worker-mount-pins',
)
const report = { providerCalls: 0, image }
const script = String.raw`
import errno,json,os,pathlib
P=pathlib.Path
blocked=[]
for source in ['/workspace/.lake','/workspace/.lake/packages','/repository/a','/repository/a/b','/repository/a/b/.lake','/repository/a/b/.lake/packages','/home/worker/.cache','/home/worker/.cache/lake']:
    target=source+'-moved'
    try:
        os.rename(source,target)
    except OSError as error:
        assert error.errno==errno.EBUSY, (source,str(error))
        blocked.append(source)
    else:
        os.rename(target,source)
        raise AssertionError('Worker could rename future host mount source: '+source)
P('/workspace/.lake/worker-cache').write_text('writable cache')
P('/workspace/.lake/packages/worker-package').mkdir()
P('/home/worker/.cache/lake/worker-cache').write_text('writable private cache')
P('/repository/a/b/Proof.lean').write_text('example : True := by trivial\n')
assert P('/workspace/Proof.lean').read_text().startswith('example')
print(json.dumps({'renameBlocked':blocked,'privateCachesWritable':True,'repositoryAliasAgrees':True}))
`
await fs.mkdir(reportDir, { recursive: true })
try {
  assert.equal((await runtime.init()).ready, true, runtime.error)
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true })
  await fs.mkdir(root, { recursive: true })
  const result = await runtime.run(root, ['python3', '-c', script], {
    network: 'none',
    repositoryRoot: checkout,
    timeoutMs: 30000,
  })
  assert.equal(result.code, 0, result.stderr || result.stdout)
  report.checks = JSON.parse(result.stdout)
  // A fixed initial clone can observe an actually empty destination. No source
  // code runs here and the directory remains unavailable to user project flows.
  const clone = path.join(directory, 'empty-clone')
  await fs.mkdir(clone)
  const empty = await runtime.run(
    clone,
    [
      'python3',
      '-c',
      "import pathlib; assert list(pathlib.Path('/workspace').iterdir()) == []; print('empty')",
    ],
    {
      network: 'none',
      emptyRepositoryClone: true,
      timeoutMs: 30000,
    },
  )
  assert.equal(empty.code, 0, empty.stderr || empty.stdout)
  assert.deepEqual(await fs.readdir(clone), [])
  const gitClone = await runtime.run(
    clone,
    [
      'python3',
      '-c',
      String.raw`
import pathlib,subprocess,tempfile
assert list(pathlib.Path('/workspace').iterdir()) == []
with tempfile.TemporaryDirectory() as source:
    def git(*args):
        subprocess.run(['git',*args],check=True,capture_output=True)
    git('init','--initial-branch=main',source)
    pathlib.Path(source,'Main.lean').write_text('example : True := by trivial\n')
    git('-C',source,'add','Main.lean')
    git('-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture')
    git('-c','protocol.file.allow=always','clone','--no-hardlinks','--',source,'.')
assert pathlib.Path('/workspace/Main.lean').read_text().startswith('example')
assert not pathlib.Path('/workspace/.lake').exists()
print('Git clone into the empty workspace succeeded')
`,
    ],
    { network: 'none', emptyRepositoryClone: true, timeoutMs: 30000 },
  )
  assert.equal(gitClone.code, 0, gitClone.stderr || gitClone.stdout)
  report.emptyClonePreserved = true
  report.realOfflineGitClone = true
  report.imageId = runtime.imageId
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack || error.message
  process.exitCode = 1
} finally {
  await runtime.shutdown()
  for (const source of [root, path.join(directory, 'empty-clone')]) {
    const key = createHash('sha256').update(source).digest('hex')
    await fs.rm(path.join(dataDir, 'runtime/homes', key), {
      recursive: true,
      force: true,
    })
  }
  await fs.rm(directory, { recursive: true, force: true })
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
}
