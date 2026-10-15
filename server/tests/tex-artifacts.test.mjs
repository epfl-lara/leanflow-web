import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTexArtifactReceiver } from '../tex-artifacts.mjs'

const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const encode = (value) => Buffer.from(value).toString('base64')
const frame = (artifacts, nonce = token) =>
  `LEANFLOW_TEX_ARTIFACTS:${nonce}:${JSON.stringify({ artifacts })}\n`
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tex-artifacts-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('artifact transfer filters split frames and Docker stderr while preserving compiler output', async (t) => {
  const directory = await fixture(t),
    visible = []
  const receiver = createTexArtifactReceiver(
    token,
    (text) => visible.push(text),
    assert.fail,
  )
  const pdf = '%PDF-1.7\n%%EOF\n'
  const transport =
    'Compiling main.tex\n' +
    frame({
      'result.json': encode('{"success":true}'),
      'document.pdf': encode(pdf),
      'document.txt': encode('Document text'),
    })
  receiver.append('docker: private /host/data mount details', 'stderr')
  for (const character of transport) receiver.append(character, 'stdout')
  const log = await receiver.publish(directory)
  assert.equal(visible.join(''), 'Compiling main.tex\n')
  assert.equal(log, 'Compiling main.tex\n')
  assert.equal(
    await fs.readFile(path.join(directory, 'document.pdf'), 'utf8'),
    pdf,
  )
  assert.equal(
    await fs.readFile(path.join(directory, 'document.txt'), 'utf8'),
    'Document text',
  )
})

test('invalid nonce, unknown names, duplicate frames, missing reports and noncanonical encodings never publish artifacts', async (t) => {
  const directory = await fixture(t)
  for (const transport of [
    frame({ 'result.json': encode('{}') }, 'wrong-nonce'),
    frame({ '../outside': encode('outside'), 'result.json': encode('{}') }),
    frame({ 'result.json': 'AA=A' }),
    frame({ 'result.json': Buffer.alloc(1024 * 1024 + 1).toString('base64') }),
    frame({ 'document.pdf': encode('pdf') }),
    frame({ 'result.json': encode('{}') }) +
      frame({ 'result.json': encode('{}') }),
    frame({ 'result.json': encode('{}') }, 'wrong-nonce') +
      frame({ 'result.json': encode('{}') }),
  ]) {
    const visible = []
    const receiver = createTexArtifactReceiver(
      token,
      (text) => visible.push(text),
      assert.fail,
    )
    receiver.append(transport, 'stdout')
    await assert.rejects(receiver.publish(directory), { status: 502 })
    assert.equal(visible.join(''), '')
    assert.deepEqual(await fs.readdir(directory), [])
  }
})

test('oversized transport records failure without throwing from a stream callback', async (t) => {
  const directory = await fixture(t),
    failures = []
  const receiver = createTexArtifactReceiver(token, assert.fail, (error) =>
    failures.push(error),
  )
  assert.doesNotThrow(() =>
    receiver.append('x'.repeat(27 * 1024 * 1024), 'stdout'),
  )
  assert.equal(failures.length, 1)
  await assert.rejects(receiver.publish(directory), { status: 502 })
  assert.deepEqual(await fs.readdir(directory), [])
  const stderrFailures = []
  const stderr = createTexArtifactReceiver(token, assert.fail, (error) =>
    stderrFailures.push(error),
  )
  assert.doesNotThrow(() => stderr.append('x'.repeat(257 * 1024), 'stderr'))
  assert.equal(stderrFailures.length, 1)
  await assert.rejects(stderr.publish(directory), { status: 502 })
})

test('artifact publication never follows existing file or directory links', async (t) => {
  const directory = await fixture(t),
    outside = path.join(directory, 'outside')
  const output = path.join(directory, 'output')
  await fs.mkdir(output)
  await fs.writeFile(outside, 'preserved')
  await fs.symlink(outside, path.join(output, 'result.json'))
  const receiver = createTexArtifactReceiver(token, () => {}, assert.fail)
  receiver.append(frame({ 'result.json': encode('changed') }), 'stdout')
  await assert.rejects(receiver.publish(output))
  assert.equal(await fs.readFile(outside, 'utf8'), 'preserved')
  const alias = path.join(directory, 'alias')
  await fs.symlink(output, alias)
  const linked = createTexArtifactReceiver(token, () => {}, assert.fail)
  linked.append(frame({ 'result.json': encode('{}') }), 'stdout')
  await assert.rejects(linked.publish(alias))
})
