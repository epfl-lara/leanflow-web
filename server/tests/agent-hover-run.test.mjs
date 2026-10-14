import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'

test('hover recovery keeps answering, while a persistent loop stops without verification and preserves usage', async (t) => {
  for (const recovers of [true, false])
    await t.test(recovers ? 'recovery' : 'persistent loop', async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-hover-'))
      const home = path.join(root, 'home')
      await fs.mkdir(path.join(home, '.lemex'), { recursive: true })
      const events = new EventStore(root),
        requests = []
      let closed = false,
        lookups = 0,
        changes = 0
      const usage = {
        total: { inputTokens: 1200 },
        last: { inputTokens: 400 },
        modelContextWindow: 190000,
      }
      const runtime = {
        home: async () => home,
        spawn: () => {
          const child = new EventEmitter()
          child.stdout = new PassThrough()
          child.stderr = new PassThrough()
          const send = (message) => {
            if (!closed) child.stdout.write(JSON.stringify(message) + '\n')
          }
          const miss = () => {
            if (closed) return
            lookups++
            send({
              method: 'item/completed',
              params: {
                item: {
                  type: 'mcpToolCall',
                  id: `hover-${lookups}`,
                  server: 'lean',
                  tool: 'lean_hover_info',
                  status: 'failed',
                  arguments: {
                    file_path: 'Main.lean',
                    line: 14,
                    column: 8 + lookups,
                  },
                  error: { message: 'No hover information at this position' },
                },
              },
            })
            if (lookups < 166 && (!recovers || lookups < 3)) setImmediate(miss)
          }
          child.stdin = new Writable({
            write(chunk, _encoding, callback) {
              for (const line of chunk.toString().trim().split('\n')) {
                const request = JSON.parse(line)
                requests.push(request)
                if (request.id !== undefined)
                  queueMicrotask(() => {
                    send({
                      id: request.id,
                      result:
                        request.method === 'thread/start'
                          ? { thread: { id: 'thread' } }
                          : request.method === 'turn/start'
                            ? { turn: { id: 'turn' } }
                            : request.method === 'turn/steer'
                              ? { turnId: 'turn' }
                              : {},
                    })
                    if (request.method === 'turn/start') {
                      send({
                        method: 'turn/started',
                        params: { turn: { id: 'turn' } },
                      })
                      send({
                        method: 'thread/tokenUsage/updated',
                        params: { tokenUsage: usage },
                      })
                      setImmediate(miss)
                    }
                    if (request.method === 'turn/steer' && recovers) {
                      send({
                        method: 'item/agentMessage/delta',
                        params: {
                          itemId: 'answer',
                          delta: 'This definition counts formula nodes.',
                        },
                      })
                      send({
                        method: 'turn/completed',
                        params: { turn: { id: 'turn', status: 'completed' } },
                      })
                    }
                  })
              }
              callback()
            },
          })
          child.kill = () => {
            if (!closed) {
              closed = true
              child.stdout.end()
              child.stderr.end()
              child.emit('close', 0)
            }
            return true
          }
          return child
        },
      }
      const manager = new AgentManager({
        runtime,
        books: {
          async prepareAgent(workerHome) {
            assert.equal(workerHome, home)
            return '\nLocal documentation is available in /home/worker/lean-books.\n'
          },
        },
        events,
        workspaces: {
          get: () => ({
            status: 'ready',
            toolchain: 'leanprover/lean4:v4.34.1',
          }),
          readFile: async () => ({ content: 'def size := 1' }),
          validateEditorContextFile: async (_project, _owner, file) => file,
          snapshot: async () => ({ root, sourceRevision: 'fixture' }),
          changes: async () => {
            changes++
            return []
          },
        },
        settings: {
          get: async () => ({ tools: { lean: true }, extraInstructions: '' }),
        },
        config: {
          provider: { LEMEX_API_KEY: 'fixture-secret' },
          defaultModel: 'fixture-model',
          models: [{ id: 'fixture-model' }],
          redact: String,
        },
      })
      t.after(async () => {
        await manager.shutdown()
        events.close()
        await fs.rm(root, { recursive: true, force: true })
      })
      const job = await manager.start('alice', 'project', {
        mode: 'search',
        prompt: 'Explain size',
        file: 'Main.lean',
      })
      await new Promise((resolve) =>
        events.on(job.id, (event) => {
          if (
            event.type === 'status' &&
            ['completed', 'failed'].includes(event.data.status)
          )
            resolve()
        }),
      )
      await manager.shutdown()
      const result = events.get(job.id)
      assert.equal(
        result.status,
        recovers ? 'completed' : 'failed',
        result.error,
      )
      assert.equal(lookups, recovers ? 3 : 6)
      assert.match(
        requests.find((request) => request.method === 'thread/start').params
          .developerInstructions,
        /Local documentation is available in \/home\/worker\/lean-books/,
      )
      assert.equal(
        requests.filter((request) => request.method === 'turn/steer').length,
        1,
      )
      assert.deepEqual(result.usage, usage)
      assert.equal(changes, recovers ? 1 : 0)
      if (recovers)
        assert.equal(result.message, 'This definition counts formula nodes.')
      else {
        assert.match(result.error, /Stopped after repeated hover lookups/)
        assert.equal(result.verification, undefined)
      }
    })
})
