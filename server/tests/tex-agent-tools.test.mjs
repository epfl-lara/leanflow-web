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
  assert.equal(
    f.tools.handle({
      method: 'item/tool/call',
      params: { tool: 'arbitrary_command' },
    }),
    false,
  )
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

test('native assistant advertises and executes document tools in every mode', async (t) => {
  const scenarios = ['search', 'proofs', 'formalize', 'optimize'].map(
    (mode) => ({ label: mode, mode }),
  )
  scenarios.push(
    {
      label: 'formalize retries a missed PDF link with a read-only turn',
      mode: 'formalize',
      retry: 'link',
    },
    {
      label: 'stopping automatic linking still verifies the review-first proof',
      mode: 'formalize',
      retry: 'skip',
    },
    {
      label: 'a run deadline during automatic linking still cancels the run',
      mode: 'formalize',
      retry: 'deadline',
    },
    {
      label: 'a failed link turn preserves the completed formalization',
      mode: 'formalize',
      retry: 'fail',
    },
  )
  for (const { label, mode, retry } of scenarios)
    await t.test(label, { timeout: 10000 }, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tex-native-rpc-'))
      const candidate = path.join(root, 'candidate'),
        home = path.join(root, 'home')
      await fs.mkdir(candidate)
      await fs.mkdir(path.join(home, '.lemex'), { recursive: true })
      const events = new EventStore(root),
        requests = [],
        starts = [],
        links = [],
        verificationCommands = []
      const linkSaveStarted = Promise.withResolvers()
      let linkSaveAttempts = 0
      const paperLink = {
        source: retry
          ? {
              path: 'paper.pdf',
              page: 3,
              quote: 'Theorem 1. The identity holds.',
            }
          : { path: 'main.tex', line: 6, label: 'thm:main' },
        target: { path: 'Main.lean', line: 3, declaration: 'mainTheorem' },
      }
      const leanChange = {
        path: 'Main.lean',
        before: '\n\ntheorem mainTheorem : True := by sorry\n',
        after: '\n\ntheorem mainTheorem : True := by trivial\n',
      }
      if (retry)
        await fs.writeFile(
          path.join(candidate, leanChange.path),
          leanChange.after,
        )
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
          files: [{ path: paperLink.source.path }],
        }),
        changes: async () => (retry ? [leanChange] : []),
        verificationCopy: async () => ({ root: candidate }),
        stageSnapshotPaperLink: async (
          snapshot,
          projectId,
          owner,
          input,
          { signal },
        ) => {
          linkSaveAttempts++
          if (retry === 'skip') {
            linkSaveStarted.resolve(signal)
            await new Promise((resolve) =>
              signal.addEventListener('abort', resolve, { once: true }),
            )
            signal.throwIfAborted()
          }
          links.push({ root: snapshot.root, projectId, owner, input })
          return { id: 'fixture-link', ...input }
        },
      }
      const runtime = {
        home: async () => home,
        run: async (_root, args, options) => {
          verificationCommands.push(args.slice(0, 2))
          let stdout = ''
          if (args[1] === 'env')
            stdout = JSON.stringify({
              LEAN_SYSROOT: '/opt/lean-toolchains/fixture',
              LEAN_PATH: '/workspace/.lake/build/lib/lean',
              LEAN_SRC_PATH: '/workspace',
            })
          if (args[0] === 'python3') {
            assert.deepEqual(JSON.parse(options.input), [leanChange.path])
            stdout = JSON.stringify({
              kernelChecked: true,
              compiled: true,
              complete: true,
              files: [{ path: leanChange.path, code: 0 }],
              axioms: [],
              errors: [],
              warnings: [],
            })
          }
          return { code: 0, stdout, stderr: '' }
        },
        spawn: () => {
          const child = new EventEmitter()
          child.stdout = new PassThrough()
          child.stderr = new PassThrough()
          const send = (value) =>
            child.stdout.write(JSON.stringify(value) + '\n')
          const complete = (id = 'turn', status = 'completed') =>
            send({
              method: 'turn/completed',
              params: { turn: { id, status } },
            })
          const reply = (itemId, delta) =>
            send({
              method: 'item/agentMessage/delta',
              params: { itemId, delta },
            })
          const link = (id, turnId, args = paperLink) =>
            send({
              id,
              method: 'item/tool/call',
              params: {
                threadId: 'thread',
                turnId,
                callId: `link-${id}`,
                tool: 'paper_link',
                arguments: args,
              },
            })
          child.stdin = new Writable({
            write(chunk, _encoding, callback) {
              for (const line of chunk.toString().trim().split('\n')) {
                const request = JSON.parse(line)
                requests.push(request)
                if (request.method === 'turn/interrupt' && retry === 'skip')
                  link(1008, 'link-turn')
                queueMicrotask(() => {
                  if (request.method && request.id !== undefined) {
                    const linkTurn = Boolean(request.params?.sandboxPolicy)
                    send({
                      id: request.id,
                      result:
                        request.method === 'thread/start'
                          ? { thread: { id: 'thread' } }
                          : request.method === 'turn/start'
                            ? { turn: { id: linkTurn ? 'link-turn' : 'turn' } }
                            : {},
                    })
                    if (request.method === 'turn/start')
                      queueMicrotask(() => {
                        if (linkTurn) {
                          if (retry === 'link') link(1004, 'turn')
                          else if (retry === 'skip') link(1007, 'link-turn')
                          else if (retry === 'fail')
                            complete('link-turn', 'failed')
                          return
                        }
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
                  } else if (request.id === 1002) {
                    if (retry) {
                      reply('formalization-answer', 'Formalized Theorem 1.')
                      complete()
                    } else link(1003, 'turn')
                  } else if (request.id === 1003) complete()
                  else if (request.id === 1004)
                    link(1005, 'link-turn', {
                      ...paperLink,
                      target: {
                        ...paperLink.target,
                        declaration: 'untouchedTheorem',
                      },
                    })
                  else if (request.id === 1005) link(1006, 'link-turn')
                  else if (request.id === 1006) {
                    reply(
                      'paper-link-answer',
                      'Linked the statement on page 3.',
                    )
                    complete('link-turn')
                  }
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
        prompt: retry ? 'Formalize Theorem 1.' : 'Inspect the current document',
        currentFile: paperLink.source.path,
        model: DEFAULT_MODEL,
        effort: 'max',
        ...(retry ? { liveEdits: false } : {}),
      })
      if (retry === 'skip' || retry === 'deadline') {
        for (
          let i = 0;
          i < 200 && !requests.some(({ params }) => params?.sandboxPolicy);
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 10))
        assert.equal(
          events.getMetadata(job.id).progress.label,
          'Linking paper and Lean',
        )
        if (retry === 'skip') {
          const linkSignal = await linkSaveStarted.promise
          const stopped = await manager.stop('alice', job.id)
          assert.equal(stopped.status, 'verifying')
          assert.equal(linkSignal.aborted, true)
        } else {
          const stopped = await manager.stop(
            'alice',
            job.id,
            'The run reached its time limit.',
          )
          assert.equal(stopped.status, 'cancelled')
          assert.deepEqual(verificationCommands, [])
        }
        assert.equal(
          requests.find(({ method }) => method === 'turn/interrupt').params
            .turnId,
          'link-turn',
        )
        assert.deepEqual(links, [])
        if (retry === 'deadline') return
      }
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
      assert.equal(init.capabilities.experimentalApi, true)
      assert.deepEqual(
        thread.dynamicTools.map((tool) => [tool.type, tool.name]),
        [
          ['function', 'tex_build'],
          ['function', 'tex_build_status'],
          ['function', 'tex_read_pdf'],
          ['function', 'paper_link'],
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
      const turns = requests.filter(({ method }) => method === 'turn/start')
      if (retry) {
        assert.equal(turns.length, 2)
        assert.match(turn.input[0].text, /formalization-paper-sources/)
        assert.match(
          thread.developerInstructions,
          /even if the user does not ask for links/,
        )
        assert.equal(turns[1].params.threadId, turn.threadId)
        assert.equal(turns[1].params.effort, turn.effort)
        assert.deepEqual(turns[1].params.sandboxPolicy, {
          type: 'readOnly',
          networkAccess: false,
        })
        assert.match(turns[1].params.input[0].text, /paper\.pdf.*mainTheorem/)
      } else {
        assert.equal(turns.length, 1)
        assert.equal(events.get(job.id).verification.kind, 'chat')
      }
      if (retry === 'skip') {
        const completed = events.get(job.id)
        assert.deepEqual(completed.changes, [leanChange])
        assert.equal(completed.message, 'Formalized Theorem 1.')
        assert.equal(completed.verification.complete, true)
        assert.equal(completed.verification.kernelChecked, true)
        assert.equal(completed.verification.editsAllowed, true)
        assert.match(completed.log, /Skipped the automatic paper link pass/)
        assert.deepEqual(verificationCommands, [
          ['lake', 'env'],
          ['lake', 'build'],
          ['python3', '-I'],
        ])
        assert.equal(
          linkSaveAttempts,
          1,
          'A late link call must not reach storage',
        )
        assert.deepEqual(links, [])
      } else if (retry === 'fail') {
        const completed = events.get(job.id)
        assert.equal(completed.message, 'Formalized Theorem 1.')
        assert.deepEqual(completed.changes, [leanChange])
        assert.match(completed.log, /paper link pass did not complete/)
        assert.deepEqual(links, [])
      } else {
        assert.equal(
          requests.find(({ id }) => id === (retry ? 1006 : 1003)).result
            .success,
          true,
        )
        assert.deepEqual(links, [
          { root: candidate, projectId: 'p', owner: 'alice', input: paperLink },
        ])
        if (retry === 'link') {
          assert.equal(
            requests.find(({ id }) => id === 1004).result.success,
            false,
          )
          assert.equal(
            requests.find(({ id }) => id === 1005).result.success,
            false,
          )
          assert.equal(
            events.get(job.id).message,
            'Formalized Theorem 1.\n\nLinked the statement on page 3.',
          )
        }
      }
    })
})
