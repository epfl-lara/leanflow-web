import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  prepareReferenceUpdates,
  applyReferenceUpdates,
} from '../workspace-reference-scan.mjs'
import { MAX_SOURCE_UPLOAD_BYTES } from '../../shared/source-limits.mjs'

const hash = (content) => createHash('sha256').update(content).digest('hex')

test('an oversized reference file is skipped without blocking other reference updates', async () => {
  const content = '![Diagram](diagram.svg)\n'
  const reads = []
  const plan = await prepareReferenceUpdates({
    from: 'diagram.svg',
    to: 'figures/diagram.svg',
    files: [
      { path: 'Large.lean', size: MAX_SOURCE_UPLOAD_BYTES + 1 },
      { path: 'README.md', size: Buffer.byteLength(content) },
      { path: 'diagram.svg', size: 6 },
    ],
    readFile: async (filename) => {
      reads.push(filename)
      assert.equal(filename, 'README.md')
      return { content, hash: hash(content) }
    },
  })
  assert.deepEqual(reads, ['README.md'])
  const changes = []
  const result = await applyReferenceUpdates(plan, {
    readFile: async () => ({ content, hash: hash(content) }),
    apply: async (batch) => changes.push(...batch),
  })
  assert.equal(changes[0].after, '![Diagram](figures/diagram.svg)\n')
  assert.equal(result.updatedReferences, 1)
  assert.equal(result.skippedFiles, 1)
  assert.match(result.warning, /Review imports and links/)
})

test('a scan whose budget has expired performs no further reads and reports incomplete updates', async () => {
  const signal = AbortSignal.abort()
  const plan = await prepareReferenceUpdates({
    from: 'diagram.svg',
    to: 'figures/diagram.svg',
    files: [
      { path: 'README.md', size: 100 },
      { path: 'diagram.svg', size: 6 },
    ],
    signal,
    readFile: () => assert.fail('An expired scan must not read another file'),
  })
  const result = await applyReferenceUpdates(plan, {
    readFile: () => assert.fail('No reference update was prepared'),
    apply: () => assert.fail('No reference update was prepared'),
  })
  assert.equal(result.updatedFiles, 0)
  assert.equal(result.skippedFiles, 1)
  assert.match(result.warning, /could not be scanned/)
})

test('a budget that expires during a file read preserves that file without parsing or applying it', async () => {
  const controller = new AbortController()
  const content = '![Diagram](diagram.svg)\n'
  const plan = await prepareReferenceUpdates({
    from: 'diagram.svg',
    to: 'figures/diagram.svg',
    files: [
      { path: 'README.md', size: Buffer.byteLength(content) },
      { path: 'diagram.svg', size: 6 },
    ],
    signal: controller.signal,
    readFile: async () => {
      controller.abort()
      return { content, hash: hash(content) }
    },
  })
  assert.deepEqual(plan.updates, [])
  assert.equal(plan.skippedFiles, 1)
})
