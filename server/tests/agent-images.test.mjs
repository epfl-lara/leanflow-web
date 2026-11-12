import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  capturedImageInputs,
  modelSupportsImages,
  agentImageInstructions,
} from '../agent-images.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-image-context-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('selected captured raster images become native inputs using only mounted paths', async (t) => {
  const root = await fixture(t)
  const names = [
    'current.PNG',
    'photo.jpeg',
    'animation.gif',
    'diagram.webp',
    'extra.jpg',
    'editable.svg',
  ]
  for (const name of names)
    await fs.writeFile(path.join(root, name), 'fixture-image-content')
  const snapshot = { root, files: names.map((file) => ({ path: file })) }
  const job = { currentFile: names[0], files: names }
  assert.deepEqual(
    await capturedImageInputs(job, snapshot, true),
    names
      .slice(0, 4)
      .map((name) => ({ type: 'localImage', path: `/workspace/${name}` })),
  )
  assert.deepEqual(await capturedImageInputs(job, snapshot, false), [])
  assert.deepEqual(
    await capturedImageInputs({ files: ['editable.svg'] }, snapshot, true),
    [],
  )
})

test('image attachments exclude files outside the capture, symlink escapes, empty images and oversized payloads', async (t) => {
  const root = await fixture(t)
  const capture = path.join(root, 'capture')
  await fs.mkdir(capture)
  await fs.writeFile(path.join(root, 'outside.png'), 'outside')
  await fs.symlink(
    path.join(root, 'outside.png'),
    path.join(capture, 'link.png'),
  )
  await fs.writeFile(path.join(capture, 'empty.png'), '')
  await fs.writeFile(path.join(capture, 'unlisted.png'), 'unlisted')
  const large = await fs.open(path.join(capture, 'large.png'), 'w')
  await large.truncate(8 * 1024 * 1024 + 1)
  await large.close()
  const files = [
    '../outside.png',
    'link.png',
    'empty.png',
    'large.png',
    'missing.png',
    'unlisted.png',
  ]
  assert.deepEqual(
    await capturedImageInputs(
      { files },
      {
        root: capture,
        files: files
          .filter((file) => file !== 'unlisted.png')
          .map((file) => ({ path: file })),
      },
      true,
    ),
    [],
  )
})

test('unknown models report unsupported image input without changing model or reasoning preferences', () => {
  const catalog = {
    models: [
      { slug: 'vision', input_modalities: ['text', 'image'] },
      { slug: 'text', input_modalities: ['text'] },
    ],
  }
  assert.equal(modelSupportsImages(catalog, 'vision'), true)
  assert.equal(modelSupportsImages(catalog, 'text'), false)
  assert.equal(modelSupportsImages(catalog, 'unknown'), false)
  assert.match(agentImageInstructions(false), /does not advertise image input/)
  assert.match(
    agentImageInstructions(false),
    /do not change the selected model or reasoning effort/,
  )
  assert.match(agentImageInstructions(true), /view_image/)
  assert.match(agentImageInstructions(true), /Markdown !\[description\]/)
})
