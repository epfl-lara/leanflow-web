import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const legacy = fileURLToPath(new URL('../index.mjs', import.meta.url))

test('PM2 selects the authenticated studio with a private backend address', () => {
  const require = createRequire(import.meta.url)
  const config = require('../../ecosystem.config.cjs')
  assert.equal(config.apps.length, 1)
  const app = config.apps[0]
  assert.equal(
    path.resolve(app.cwd, app.script),
    path.join(root, 'server/studio.mjs'),
  )
  assert.equal(app.env.HOST, '127.0.0.1')
  assert.equal(app.env.NODE_ENV, 'production')
})

test('default and production CLI launches refuse the legacy server before opening a listener', async () => {
  for (const env of [
    { NODE_ENV: '', LEANFLOW_LEGACY_DEV: '' },
    { NODE_ENV: 'development', LEANFLOW_LEGACY_DEV: '' },
    { NODE_ENV: 'production', LEANFLOW_LEGACY_DEV: '1' },
  ])
    await assert.rejects(
      execute(process.execPath, [legacy], {
        cwd: os.tmpdir(),
        env: { ...process.env, ...env, PORT: '0' },
        timeout: 5000,
      }),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /unauthenticated legacy server is disabled/)
        assert.match(error.stderr, /npm start/)
        assert.doesNotMatch(error.stdout, /HTTP.*on port/)
        return true
      },
    )
})

test('explicit legacy development uses loopback even when HOST asks for all interfaces', async (t) => {
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-legacy-entry-'))
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    LEANFLOW_LEGACY_DEV: '1',
    NO_BWRAP: 'true',
    VITE_COLLAB: 'false',
    HOST: '0.0.0.0',
    PORT: '0',
    PROJECTS_BASE_PATH: path.relative(root, projects),
  }
  delete env.SSL_CRT_FILE
  delete env.SSL_KEY_FILE
  const runner = `
    import http from 'node:http'
    const listen = http.Server.prototype.listen
    http.Server.prototype.listen = function (...args) {
      this.once('listening', () => process.send(this.address()))
      return listen.apply(this, args)
    }
    await import(${JSON.stringify(new URL('../index.mjs', import.meta.url).href)})
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM')
    await exited
    await fs.rm(projects, { recursive: true, force: true })
  })
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Legacy fixture did not listen. ' + stderr)),
      5000,
    )
    child.once('message', (message) => {
      clearTimeout(timeout)
      resolve(message)
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Legacy fixture exited (${code}). ${stderr}`))
    })
  })
  assert.equal(address.address, '127.0.0.1')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/projects`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [])
})
