import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { bridgeNode } from '../cluster/node.mjs'
import net from 'node:net'
import { PassThrough } from 'node:stream'

const execute = promisify(execFile)

test('the worker entry point executes through a deployment symlink', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-entry-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const target = fileURLToPath(new URL('../cluster/node.mjs', import.meta.url))
  const link = path.join(directory, 'node.mjs')
  await fs.symlink(target, link)
  await assert.rejects(
    execute(process.execPath, [link]),
    (error) => error.code === 1 && /Usage: node/.test(error.stderr),
  )
})

test('the forced bridge rejects an SSH shell command before opening a socket', async () => {
  const previous = process.env.SSH_ORIGINAL_COMMAND
  process.env.SSH_ORIGINAL_COMMAND = 'cat /etc/passwd'
  let started = false
  try {
    await assert.rejects(
      bridgeNode(
        { socketPath: '/does-not-exist', startUserService: true },
        undefined,
        undefined,
        {
          startUserService: () => {
            started = true
          },
        },
      ),
      /Only the LeanFlow worker protocol/,
    )
    assert.equal(started, false)
  } finally {
    if (previous === undefined) delete process.env.SSH_ORIGINAL_COMMAND
    else process.env.SSH_ORIGINAL_COMMAND = previous
  }
})

test('the user bridge starts only its fixed service and waits for its private socket', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lf-bridge-')),
  )
  const socketPath = path.join(directory, 'node.sock')
  const server = net.createServer((socket) =>
    socket.once('data', (data) => {
      assert.equal(data.toString(), 'request')
      socket.end('response')
    }),
  )
  t.after(async () => {
    server.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const previous = process.env.SSH_ORIGINAL_COMMAND
  process.env.SSH_ORIGINAL_COMMAND = 'leanflow-node-control'
  let starts = 0,
    output = ''
  const input = new PassThrough(),
    sink = new PassThrough()
  sink.on('data', (data) => {
    output += data.toString()
  })
  try {
    const task = bridgeNode(
      { socketPath, startUserService: true },
      input,
      sink,
      {
        startUserService: async () => {
          starts++
          setTimeout(() => server.listen(socketPath), 30)
        },
      },
    )
    input.end('request')
    await task
    assert.equal(starts, 1)
    assert.equal(output, 'response')
  } finally {
    if (previous === undefined) delete process.env.SSH_ORIGINAL_COMMAND
    else process.env.SSH_ORIGINAL_COMMAND = previous
  }
})
