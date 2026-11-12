#!/usr/bin/env node
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { workerBundleDigest } from '../server/cluster/config.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const arguments_ = process.argv.slice(2)
if (
  arguments_[0] !== '--output' ||
  !arguments_[1] ||
  arguments_.slice(2).some((value) => value !== '--allow-dirty')
)
  throw new Error(
    'Usage: node scripts/package-cluster-worker.mjs --output /private/output [--allow-dirty]',
  )
const output = path.resolve(arguments_[1])
const { stdout: status } = await execute('git', ['status', '--porcelain'], {
  cwd: root,
})
const dirty = !!status.trim()
if (dirty && !arguments_.includes('--allow-dirty'))
  throw new Error(
    'Commit the reviewed source before producing a release bundle, or explicitly label a test bundle with --allow-dirty.',
  )
const { stdout: revision } = await execute('git', ['rev-parse', 'HEAD'], {
  cwd: root,
})
const expected = await workerBundleDigest(root)
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'leanflow-worker-bundle-'),
)
const files = []
try {
  async function copy(relative) {
    const source = path.join(root, relative)
    const stat = await fs.lstat(source)
    if (stat.isSymbolicLink())
      throw new Error(
        'Worker releases cannot contain symbolic links: ' + relative,
      )
    if (stat.isDirectory()) {
      await fs.mkdir(path.join(temporary, relative), {
        recursive: true,
        mode: 0o755,
      })
      for (const name of (await fs.readdir(source)).sort()) {
        if (['node_modules', 'tests', '__pycache__'].includes(name)) continue
        if (
          /^\.env(?:\.|$)/i.test(name) ||
          ['.git', '.data', '.runtime', '.ssh', '.lemex', '.codex'].includes(
            name,
          )
        )
          throw new Error(
            'Private or generated state cannot enter a release: ' +
              relative +
              '/' +
              name,
          )
        await copy(path.posix.join(relative, name))
      }
    } else if (stat.isFile()) {
      const bytes = await fs.readFile(source)
      await fs.writeFile(path.join(temporary, relative), bytes, {
        mode: stat.mode & 0o111 ? 0o755 : 0o644,
        flag: 'wx',
      })
      files.push({
        path: relative,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    } else
      throw new Error(
        'Only regular source files belong in worker releases: ' + relative,
      )
  }
  for (const relative of ['server', 'shared', 'deploy']) await copy(relative)
  if ((await workerBundleDigest(temporary)) !== expected)
    throw new Error('Source changed while packaging the worker.')
  const manifest = {
    version: 1,
    bundleDigest: expected,
    sourceRevision: revision.trim(),
    dirty,
    files,
  }
  await fs.writeFile(
    path.join(temporary, 'worker-release.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o644 },
  )
  await fs.mkdir(output, { recursive: true, mode: 0o700 })
  const name = `leanflow-worker-${expected}.tar.gz`
  const archive = path.join(output, name)
  const handle = await fs.open(archive, 'wx', 0o600)
  await handle.close()
  try {
    await execute(
      'tar',
      ['--no-xattrs', '-czf', archive, '-C', temporary, '.'],
      {
        maxBuffer: 1024 * 1024,
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
    )
  } catch (error) {
    await fs.rm(archive, { force: true })
    throw error
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  const archiveDigest = hash.digest('hex')
  await fs.writeFile(archive + '.sha256', archiveDigest + '  ' + name + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  process.stdout.write(
    JSON.stringify({
      archive,
      archiveDigest,
      bundleDigest: expected,
      sourceRevision: manifest.sourceRevision,
      dirty,
      files: files.length,
    }) + '\n',
  )
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
