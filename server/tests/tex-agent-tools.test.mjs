import profiles from '../lemex-models.json' with { type: 'json' }
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTexAgentTools } from '../tex-agent-tools.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'
import { catalogModels } from '../config.mjs'
import { DEFAULT_MODEL, rcpModelCatalog } from '../model-catalog.mjs'

function fixture(overrides = {}) {
  const responses = [],
    starts = []
  const active = {
    controller: new AbortController(),
    threadId: 'thread',
    turnId: 'turn',
  }
  const build = {
    id: 'build',
    projectId: 'project',
    status: 'completed',
    sourceRevision: 'captured',
    log: 'log',
  }
  const manager = {
    start: async (...args) => {
      starts.push(args)
      return { ...build, status: 'queued' }
    },
    wait: async () => ({ ...build }),
    get: () => ({ ...build }),
    readText: async () => ({
      content: 'First page\fSecond page',
      path: 'document.txt',
    }),
    ...overrides,
  }
  const tools = createTexAgentTools({
    manager,
    job: { id: 'run', owner: 'alice', projectId: 'project' },
    snapshot: { root: '/private/candidate' },
    active,
    rpc: { respond: (id, result) => responses.push({ id, ...result }) },
  })
  let next = 0
  async function call(tool, args, extra = {}) {
    const id = ++next
    assert(
      tools.handle({
        id,
        method: 'item/tool/call',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          callId: `call-${id}`,
          tool,
          arguments: args,
          ...extra,
        },
      }),
    )
    for (
      let count = 0;
      count < 100 && !responses.some((r) => r.id === id);
      count++
    )
      await new Promise((resolve) => setImmediate(resolve))
    const result = responses.find((r) => r.id === id)
    assert(result, 'Tool callback must respond')
    return result
  }
  return { tools, manager, active, starts, call }
}

test('native TeX tool builds the assistant snapshot and reads bounded PDF text', async () => {
  const f = fixture()
  const result = await f.call('tex_build', { rootFile: 'paper/main.tex' })
  assert.equal(result.success, true)
  assert.equal(
    JSON.parse(result.contentItems[0].text).sourceRevision,
    'captured',
  )
  assert.deepEqual(f.starts[0].slice(0, 3), [
    'alice',
    'project',
    { rootFile: 'paper/main.tex', engine: 'pdflatex' },
  ])
  assert.deepEqual(
    { ...f.starts[0][3], signal: undefined },
    {
      sourceRoot: '/private/candidate',
      runId: 'run',
      origin: 'agent',
      signal: undefined,
    },
  )
  const text = JSON.parse(
    (await f.call('tex_read_pdf', { buildId: 'build', offset: 6, limit: 5 }))
      .contentItems[0].text,
  )
  assert.equal(text.text, 'page\f')
  assert.equal(text.nextOffset, 11)
  assert.equal(text.sourceRevision, 'captured')
  await f.tools.dispose()
})

test('native TeX callbacks reject cross-thread, stale-turn, unknown and foreign artifact calls', async () => {
  const f = fixture()
  for (const extra of [
    { threadId: 'other' },
    { turnId: 'old' },
    { namespace: 'foreign' },
  ])
    assert.equal(
      (await f.call('tex_build', { rootFile: 'main.tex' }, extra)).success,
      false,
    )
  assert.equal(
    (await f.call('tex_read_pdf', { buildId: 'foreign' })).success,
    false,
  )
  assert.equal((await f.call('arbitrary_command', {})).success, false)
  assert.equal(f.starts.length, 0)
  await f.call('tex_build', { rootFile: 'main.tex' })
  f.manager.get = () => ({ id: 'build', projectId: 'other-project' })
  assert.equal(
    (await f.call('tex_build_status', { buildId: 'build' })).success,
    false,
  )
  f.manager.get = () => {
    throw Object.assign(new Error('Job not found.'), { status: 404 })
  }
  const expired = await f.call('tex_read_pdf', { buildId: 'build' })
  assert.equal(expired.success, false)
  assert.match(
    expired.contentItems[0].text,
    /expired.*Compile the document again/,
  )
  await f.tools.dispose()
})

test('native TeX tool validates paths, engines and text chunk arguments at the host boundary', async () => {
  const f = fixture()
  for (const input of [
    null,
    [],
    { rootFile: '../secret.tex' },
    { rootFile: '.env' },
    { rootFile: 'main.tex', engine: 'xelatex' },
    { rootFile: 'main.tex', command: 'unsafe' },
  ])
    assert.equal((await f.call('tex_build', input)).success, false)
  assert.equal(f.starts.length, 0)
  await f.call('tex_build', { rootFile: 'main.tex' })
  for (const input of [
    { offset: -1 },
    { limit: 1000000 },
    { offset: 1.5 },
    { limit: 0 },
    { limit: '100' },
  ])
    assert.equal(
      (await f.call('tex_read_pdf', { buildId: 'build', ...input })).success,
      false,
    )
  await f.tools.dispose()
})

test('session shutdown cancels a pending compile before returning', async () => {
  let stopped = false
  const f = fixture({
    wait: async () => {
      await new Promise((resolve) =>
        f.starts[0][3].signal.addEventListener('abort', resolve, {
          once: true,
        }),
      )
      stopped = true
      return { id: 'build', projectId: 'project', status: 'cancelled' }
    },
  })
  const result = f.call('tex_build', { rootFile: 'main.tex' })
  await new Promise((resolve) => setImmediate(resolve))
  await f.tools.dispose()
  assert.equal(stopped, true)
  assert.equal((await result).success, false)
  assert.equal(
    (await f.call('tex_build', { rootFile: 'main.tex' })).success,
    false,
  )
})

test('agent cancellation propagates to the isolated compiler', async () => {
  const f = fixture()
  await f.call('tex_build', { rootFile: 'main.tex' })
  f.active.controller.abort()
  assert.equal(f.starts[0][3].signal.aborted, true)
  assert.equal(
    (await f.call('tex_read_pdf', { buildId: 'build' })).success,
    false,
  )
  await f.tools.dispose()
})

test('completed turns reject late native TeX callbacks and extracted text reports page truncation', async () => {
  const f = fixture({
    readText: async () => ({
      content: 'First pages',
      textTruncated: true,
      pageCount: 300,
    }),
  })
  await f.call('tex_build', { rootFile: 'main.tex' })
  const result = await f.call('tex_read_pdf', { buildId: 'build' })
  const text = JSON.parse(result.contentItems[0].text)
  assert.equal(text.textTruncated, true)
  assert.equal(text.pageCount, 300)
  f.active.completed = true
  assert.equal(
    (await f.call('tex_build', { rootFile: 'main.tex' })).success,
    false,
  )
  assert.equal(f.starts.length, 1)
  await f.tools.dispose()
})

test('native assistant advertises and executes TeX tools in search while proof mode preserves its protocol', async (t) => {
  for (const mode of ['search', 'proofs'])
    await t.test(mode, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tex-native-rpc-'))
      const candidate = path.join(root, 'candidate'),
        home = path.join(root, 'home')
      await fs.mkdir(candidate)
      await fs.mkdir(path.join(home, '.lemex'), { recursive: true })
      const events = new EventStore(root),
        requests = [],
        starts = []
      const build = {
        id: 'native-build',
        projectId: 'p',
        rootFile: 'main.tex',
        status: 'completed',
        sourceRevision: 'native-captured',
      }
      const workspaces = {
        get: (id) => ({
          id,
          status: 'ready',
          name: 'Fixture',
          toolchain: 'leanprover/lean4:v4.34.1',
        }),
        validateEditorContextFile: async (_id, _owner, file) => file,
        snapshot: async () => ({
          root: candidate,
          projectId: 'p',
          owner: 'alice',
          sourceRevision: 'saved',
        }),
        changes: async () => [],
        verificationCopy: async () => ({ root: candidate }),
      }
      const runtime = {
        home: async () => home,
        spawn: () => {
          const child = new EventEmitter()
          child.stdout = new PassThrough()
          child.stderr = new PassThrough()
          const send = (value) =>
            child.stdout.write(JSON.stringify(value) + '\n')
          const complete = () =>
            send({
              method: 'turn/completed',
              params: { turn: { id: 'turn', status: 'completed' } },
            })
          child.stdin = new Writable({
            write(chunk, _encoding, callback) {
              for (const line of chunk.toString().trim().split('\n')) {
                const request = JSON.parse(line)
                requests.push(request)
                queueMicrotask(() => {
                  if (request.method && request.id !== undefined) {
                    send({
                      id: request.id,
                      result:
                        request.method === 'thread/start'
                          ? { thread: { id: 'thread' } }
                          : request.method === 'turn/start'
                            ? { turn: { id: 'turn' } }
                            : {},
                    })
                    if (request.method === 'turn/start')
                      queueMicrotask(() => {
                        if (mode === 'search')
                          send({
                            id: 1001,
                            method: 'item/tool/call',
                            params: {
                              threadId: 'thread',
                              turnId: 'turn',
                              callId: 'compile',
                              tool: 'tex_build',
                              arguments: { rootFile: 'main.tex' },
                            },
                          })
                        else complete()
                      })
                  } else if (request.id === 1001) {
                    send({
                      id: 1002,
                      method: 'item/tool/call',
                      params: {
                        threadId: 'thread',
                        turnId: 'turn',
                        callId: 'read',
                        tool: 'tex_read_pdf',
                        arguments: { buildId: 'native-build' },
                      },
                    })
                  } else if (request.id === 1002) complete()
                })
              }
              callback()
            },
          })
          child.kill = () => {
            child.stdout.end()
            child.stderr.end()
            child.emit('close', 0)
            return true
          }
          return child
        },
      }
      const modelCatalog = rcpModelCatalog({
        models: [profiles.models.find((model) => model.slug === DEFAULT_MODEL)],
      })
      const manager = new AgentManager({
        runtime,
        workspaces,
        events,
        texBuilds: {
          start: async (...args) => {
            starts.push(args)
            return { ...build, status: 'queued' }
          },
          wait: async () => ({ ...build }),
          get: () => ({ ...build }),
          readText: async () => ({ content: 'Rendered theorem text' }),
        },
        settings: {
          get: async () => ({
            tools: { lean: true, lean_explore: false, exa: false },
          }),
        },
        config: {
          provider: { LEMEX_API_KEY: 'fake-test-secret' },
          defaultModel: DEFAULT_MODEL,
          models: catalogModels(modelCatalog, DEFAULT_MODEL),
          modelCatalog,
          redact: String,
        },
      })
      t.after(async () => {
        await manager.shutdown()
        events.close()
        await fs.rm(root, { recursive: true, force: true })
      })
      const job = await manager.start('alice', 'p', {
        mode,
        prompt: 'Inspect the current document',
        currentFile: 'main.tex',
        model: DEFAULT_MODEL,
        effort: 'max',
      })
      for (
        let i = 0;
        i < 200 &&
        !['completed', 'failed'].includes(events.getMetadata(job.id).status);
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(
        events.getMetadata(job.id).status,
        'completed',
        events.getMetadata(job.id).error,
      )
      await manager.shutdown()
      const init = requests.find(
        (request) => request.method === 'initialize',
      ).params
      const thread = requests.find(
        (request) => request.method === 'thread/start',
      ).params
      const turn = requests.find(
        (request) => request.method === 'turn/start',
      ).params
      assert.equal(thread.model, DEFAULT_MODEL)
      assert.equal(turn.effort, 'max')
      if (mode === 'search') {
        assert.equal(init.capabilities.experimentalApi, true)
        assert.deepEqual(
          thread.dynamicTools.map((tool) => [tool.type, tool.name]),
          [
            ['function', 'tex_build'],
            ['function', 'tex_build_status'],
            ['function', 'tex_read_pdf'],
          ],
        )
        assert.equal(starts.length, 1)
        assert.equal(starts[0][3].sourceRoot, candidate)
        assert.equal(starts[0][3].runId, job.id)
        assert.equal(
          requests.find((request) => request.id === 1001).result.success,
          true,
        )
        assert.match(
          requests.find((request) => request.id === 1002).result.contentItems[0]
            .text,
          /Rendered theorem text/,
        )
        assert.equal(events.get(job.id).verification.kind, 'chat')
      } else {
        assert.equal(init.capabilities, undefined)
        assert.equal(thread.dynamicTools, undefined)
        assert.equal(starts.length, 0)
      }
    })
})
