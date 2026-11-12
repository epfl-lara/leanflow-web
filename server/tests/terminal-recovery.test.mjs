import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { installTerminalRecoveryRoutes } from '../terminal-recovery.mjs'

async function recoveryDownloads(t, downloadLimits) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'terminal-recovery-limit-'),
  )
  await fs.writeFile(path.join(root, 'Main.lean'), '-- private proof\n')
  await fs.writeFile(path.join(root, 'Other.lean'), '-- another proof\n')
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: 'alice' }
    next()
  })
  installTerminalRecoveryRoutes(
    app,
    {
      terminalRecovery: async () => ({ root, name: 'Private copy' }),
      async readTerminalRecoveryFile(
        _project,
        _actor,
        _run,
        filename,
        options,
      ) {
        const content = await fs.readFile(path.join(root, filename))
        if (content.length > options.byteLimit)
          throw Object.assign(
            new Error('File exceeds the download byte limit.'),
            { status: 413 },
          )
        return { content, mode: 0o600 }
      },
    },
    { downloadLimits },
  )
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  )
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}/api/projects/project/terminal-recoveries/private-copy`
  return (suffix) =>
    fetch(`${base}/${suffix}`, { signal: AbortSignal.timeout(5000) })
}

test('recovery enumeration limits direct ZIP and listing requests to administrator recovery', async (t) => {
  for (const limits of [{ entries: 1 }, { scanEntries: 1 }]) {
    await t.test(Object.keys(limits)[0], async (t) => {
      const request = await recoveryDownloads(t, limits)
      for (const endpoint of ['download', 'files']) {
        const response = await request(endpoint)
        assert.equal(response.status, 413)
        const body = await response.json()
        assert.match(body.error, /too many entries to list or download safely/)
        assert.match(
          body.error,
          /Ask the server administrator to recover its files/,
        )
        assert.doesNotMatch(
          body.error,
          /Choose individual files|as a ZIP|Try again|retry/i,
        )
      }
      // Directly selecting a known file does not enumerate the private copy.
      const selected = await request('download?path=Main.lean')
      assert.equal(selected.status, 200)
      assert.equal(await selected.text(), '-- private proof\n')
    })
  }
})

test('only byte-limited recovery ZIPs recommend the available individual file list', async (t) => {
  const request = await recoveryDownloads(t, { archiveBytes: 1 })
  const archive = await request('download')
  assert.equal(archive.status, 413)
  assert.match(
    (await archive.json()).error,
    /Choose individual files to recover smaller files/,
  )
  const listing = await request('files')
  assert.equal(listing.status, 200)
  assert.deepEqual(
    (await listing.json()).files.map((file) => file.path).sort(),
    ['Main.lean', 'Other.lean'],
  )
  const selected = await request('download?path=Main.lean')
  assert.equal(selected.status, 200)
  assert.equal(await selected.text(), '-- private proof\n')
})

test('recovery file listing holds download admission until the response finishes', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'terminal-recovery-list-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'Main.lean'), '-- private files\n')
  const routes = new Map()
  installTerminalRecoveryRoutes(
    { get: (route, handler) => routes.set(route, handler), delete() {} },
    { terminalRecovery: async () => ({ root }) },
  )
  const list = routes.get('/api/projects/:id/terminal-recoveries/:runId/files')
  const request = {
    params: { id: 'project', runId: 'private-copy' },
    user: { id: 'alice' },
    query: {},
  }
  const response = () => {
    const res = new EventEmitter()
    res.statusCode = 200
    res.setHeader = () => {}
    res.status = (value) => {
      res.statusCode = value
      return res
    }
    res.sent = new Promise((resolve) => {
      res.json = (value) => {
        resolve(value)
        return res
      }
    })
    return res
  }
  const first = response()
  const pending = list(request, first)
  t.after(() => first.emit('close'))
  assert.equal((await first.sent).files[0].path, 'Main.lean')
  const busy = response()
  await list(request, busy)
  assert.equal(busy.statusCode, 429)
  first.emit('finish')
  await pending
  const next = response()
  const completed = list(request, next)
  assert.equal((await next.sent).files[0].path, 'Main.lean')
  next.emit('finish')
  await completed
  assert.equal(next.statusCode, 200)
})
