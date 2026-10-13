#!/usr/bin/env node
// Real Docker regression for symlinked dependency mounts. Only owned fixtures
// are used; no existing project data, provider, or production worker is touched.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'

const dataDir = path.resolve('.data/runtime/dependency-boundary', randomUUID())
const source = path.join(dataDir, 'selected-source')
const candidate = path.join(dataDir, 'selected-candidate')
const sibling = path.join(dataDir, 'unrelated-project')
const image =
  process.env.LEAN_PROBE_TEST_IMAGE || 'lemex-web-worker:lean-probe-646cb0ee'
const runtime = new Runtime({ dataDir, image, scope: 'helper' })
const reportDir = path.resolve('.runtime/dependency-containment')
const report = { providerCalls: 0, fixtureOnly: true, image, checks: [] }
const unsafe = /real directories inside the selected dependency project/
try {
  await fs.mkdir(path.join(source, '.lake/packages'), { recursive: true })
  await fs.mkdir(candidate, { recursive: true })
  await fs.mkdir(path.join(sibling, 'packages'), { recursive: true })
  await fs.writeFile(
    path.join(source, '.lake/packages/selected.txt'),
    'SELECTED_DEPENDENCY',
  )
  await fs.writeFile(
    path.join(sibling, 'private.txt'),
    'UNRELATED_FIXTURE_SENTINEL',
  )
  await fs.writeFile(
    path.join(sibling, 'packages/private.txt'),
    'UNRELATED_FIXTURE_SENTINEL',
  )
  assert.equal((await runtime.init()).ready, true, runtime.error)
  await runtime.inheritDependencies(source, candidate)
  const check = await runtime.run(
    candidate,
    [
      '/usr/bin/python3',
      '-c',
      `
from pathlib import Path
assert Path('/workspace/.lake/packages/selected.txt').read_text() == 'SELECTED_DEPENDENCY'
assert not Path('/workspace/.lake/packages/private.txt').exists()
assert not Path(${JSON.stringify(sibling)}).exists()
try:
    Path('/workspace/.lake/packages/selected.txt').write_text('changed')
except OSError:
    pass
else:
    raise AssertionError('Selected dependencies were writable')
print('Only the selected dependencies are readable, with writes denied.')
`,
    ],
    { network: 'none', timeoutMs: 30000 },
  )
  assert.equal(check.code, 0, check.stderr)
  report.checks.push(check.stdout.trim())
  await fs.rename(
    path.join(source, '.lake/packages'),
    path.join(source, '.lake/packages-valid'),
  )
  await fs.symlink(sibling, path.join(source, '.lake/packages'))
  assert.throws(() => runtime.dependencyRoot(source), unsafe)
  await assert.rejects(runtime.inheritDependencies(source, candidate), unsafe)
  await assert.rejects(runtime.run(candidate, ['true']), unsafe)
  report.checks.push(
    'A replaced packages directory cannot expose another project through lookup, inheritance, or a previously registered worker mount.',
  )
  await fs.unlink(path.join(source, '.lake/packages'))
  await fs.rename(
    path.join(source, '.lake/packages-valid'),
    path.join(source, '.lake/packages'),
  )
  await fs.rename(path.join(source, '.lake'), path.join(source, '.lake-valid'))
  await fs.symlink(sibling, path.join(source, '.lake'))
  assert.throws(() => runtime.dependencyRoot(source), unsafe)
  await assert.rejects(runtime.inheritDependencies(source, candidate), unsafe)
  await assert.rejects(runtime.run(candidate, ['true']), unsafe)
  report.checks.push(
    'A replaced .lake ancestor cannot expose another project through an existing dependency registration.',
  )
  assert.equal(
    await fs.readFile(path.join(sibling, 'private.txt'), 'utf8'),
    'UNRELATED_FIXTURE_SENTINEL',
  )
  report.imageId = runtime.imageId
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack || error.message
  process.exitCode = 1
} finally {
  await runtime.shutdown()
  await fs.rm(dataDir, { recursive: true, force: true })
  await fs.mkdir(reportDir, { recursive: true })
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
}
