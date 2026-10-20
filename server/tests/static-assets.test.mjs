import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { staticAssets } from '../static-assets.mjs'

test('only fingerprinted build assets are immutable; deployments refresh the entry page and public files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-assets-'))
  await fs.mkdir(path.join(directory, 'assets'))
  for (const name of [
    'index.html',
    'manifest.json',
    'worker.js',
    'assets/editor.js',
    'assets/index-AB12cd_9.js',
    'assets/style-xy12CD_9.css',
  ])
    await fs.writeFile(path.join(directory, name), 'fixture')
  const app = express()
  app.use(staticAssets(directory))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  const get = (url, options) =>
    fetch(`http://127.0.0.1:${server.address().port}${url}`, options)
  for (const name of [
    '/',
    '/index.html',
    '/manifest.json',
    '/worker.js',
    '/assets/editor.js',
  ]) {
    const response = await get(name)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-cache', name)
    await response.text()
  }
  for (const name of [
    '/assets/index-AB12cd_9.js',
    '/assets/style-xy12CD_9.css',
  ]) {
    const response = await get(name)
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    )
    await response.text()
    const cached = await get(name, {
      cache: 'no-cache',
      headers: { 'If-None-Match': response.headers.get('etag') },
    })
    assert.equal(cached.status, 304)
    assert.match(cached.headers.get('cache-control'), /immutable/)
  }
  const before = await get('/')
  await before.text()
  await fs.writeFile(path.join(directory, 'index.html'), 'new deployment')
  const after = await get('/', {
    headers: { 'If-None-Match': before.headers.get('etag') },
  })
  assert.equal(after.status, 200)
  assert.equal(await after.text(), 'new deployment')
})
