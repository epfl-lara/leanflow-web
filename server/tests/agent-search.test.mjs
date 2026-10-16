import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const auditEnv = {
  LEAN_SYSROOT: '/opt/lean-toolchains/leanprover--lean4---v4.34.1',
  LEAN_PATH:
    '/workspace/.lake/build/lib/lean:/opt/lean-toolchains/leanprover--lean4---v4.34.1/lib/lean',
  LEAN_SRC_PATH: '/workspace',
}

async function fixture(t, edit = async () => {}, { buildFails = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-ask-search-'))
  const calls = [],
    requests = []
  const runtime = {
    templates: () => [{ id: 'lean', toolchain }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async home() {
      const home = path.join(root, 'home')
      await fs.mkdir(path.join(home, '.lemex'), { recursive: true })
      return home
    },
    async run(workspace, args, options) {
      if (args[0] !== 'git') calls.push({ workspace, args, options })
      if (args[0] === 'lake' && args[1] === 'update')
        await fs.writeFile(
          path.join(workspace, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(workspace, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'lake' && args[1] === 'env')
        return { code: 0, stdout: JSON.stringify(auditEnv), stderr: '' }
      if (args[0] === 'lake' && args[1] === 'build' && buildFails)
        return { code: 1, stdout: 'Lean type mismatch', stderr: '' }
      if (args[0] === 'python3')
        return {
          code: 0,
          stdout: JSON.stringify({
            compiled: true,
            complete: true,
            kernelChecked: true,
            files: [{ path: 'Main.lean' }],
            errors: [],
            warnings: [],
            axioms: [],
          }),
          stderr: '',
        }
      return { code: 0, stdout: 'Lean version 4.34.1', stderr: '' }
    },
    spawn(workspace) {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      let closed = false
      const send = (message) => {
        if (!closed) child.stdout.write(JSON.stringify(message) + '\n')
      }
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          for (const line of chunk.toString().trim().split('\n')) {
            const request = JSON.parse(line)
            requests.push(request)
            if (request.id === undefined) continue
            queueMicrotask(() => {
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
                void edit(workspace).then(
                  () => {
                    send({
                      method: 'item/agentMessage/delta',
                      params: {
                        itemId: 'answer',
                        delta: 'Here is the requested answer or file work.',
                      },
                    })
                    send({
                      method: 'turn/completed',
                      params: { turn: { id: 'turn', status: 'completed' } },
                    })
                  },
                  (error) => child.emit('error', error),
                )
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
  const workspaces = await new WorkspaceStore({ dataDir: root, runtime }).init()
  const project = await workspaces.create('alice', {
    preset: 'lean',
    name: 'Ask fixture',
  })
  await workspaces.jobs.get(project.id)
  assert.equal(workspaces.get(project.id, 'alice').status, 'ready')
  const events = new EventStore(root)
  const manager = new AgentManager({
    runtime,
    workspaces,
    events,
    settings: { get: async () => ({ tools: {}, extraInstructions: '' }) },
    config: {
      provider: { LEMEX_API_KEY: 'fake' },
      models: [{ id: 'fixture' }],
      defaultModel: 'fixture',
      redact: String,
    },
  })
  t.after(async () => {
    await manager.shutdown()
    events.close()
    workspaces.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  calls.length = 0
  async function execute(prompt, selected = {}) {
    const job = await manager.start('alice', project.id, {
      mode: 'search',
      prompt,
      ...selected,
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
    await Promise.all([...manager.tasks])
    return events.get(job.id)
  }
  return { manager, workspaces, project, calls, requests, events, execute }
}

test('Formalize receives open or attached documents and independently verifies new Lean output', async (t) => {
  for (const document of [
    'Paper.PDF',
    'paper.tex',
    'notes.txt',
    'notes.md',
    'notes.rst',
  ])
    for (const attached of [false, true])
      await t.test(`${document}, attached=${attached}`, async (t) => {
        const source = document.endsWith('.PDF')
          ? Buffer.from('%PDF-1.7\n\0binary reference\n%%EOF\n')
          : Buffer.from('Theorem: True. Proof: trivial.\n')
        const lean = 'theorem from_document : True := by trivial\n'
        const { manager, workspaces, project, calls, requests, execute } =
          await fixture(t, async (workspace) => {
            assert.deepEqual(
              await fs.readFile(path.join(workspace, document)),
              source,
            )
            await fs.writeFile(path.join(workspace, 'Main.lean'), lean)
          })
        await fs.writeFile(path.join(project.root, document), source)
        await fs.unlink(path.join(project.root, 'Main.lean'))
        const result = await execute('Formalize the theorem in the document.', {
          mode: 'formalize',
          currentFile: document,
          files: attached ? [document] : [],
          liveEdits: false,
        })
        assert.equal(result.status, 'completed', result.error)
        assert.equal(result.file, null)
        assert.equal(result.currentFile, document)
        assert.equal(result.verification.complete, true)
        assert.equal(result.verification.kernelChecked, true)
        assert.deepEqual(
          result.changes.map((change) => change.path),
          ['Main.lean'],
        )
        assert.equal(result.changes[0].before, null)
        assert.equal(
          calls.length,
          3,
          'Lean output must run the independent verification pipeline',
        )
        const envelope = JSON.parse(
          requests.find((request) => request.method === 'turn/start').params
            .input[0].text,
        )
        assert(
          envelope.leanflowContext.sections
            .join('\n')
            .includes(JSON.stringify(document)),
        )
        assert(!JSON.stringify(envelope).includes('binary reference'))
        await assert.rejects(fs.access(path.join(project.root, 'Main.lean')), {
          code: 'ENOENT',
        })
        await manager.apply('alice', result.id)
        assert.equal(
          (await workspaces.readFile(project.id, 'alice', 'Main.lean')).content,
          lean,
        )
        assert.deepEqual(
          await fs.readFile(path.join(project.root, document)),
          source,
        )
      })
})

test('Formalize without Lean output never certifies an unchanged project as a completed formalization', async (t) => {
  for (const file of [undefined, 'Main.lean'])
    await t.test(file || 'no Lean target', async (t) => {
      const { manager, workspaces, calls, execute } = await fixture(t)
      workspaces.verificationCopy = () =>
        assert.fail('No-output runs must not copy the project for verification')
      const result = await execute('Formalize the source.', {
        mode: 'formalize',
        file,
        currentFile: null,
        files: [],
        liveEdits: false,
      })
      assert.equal(result.status, 'completed', result.error)
      assert.equal(result.verification.complete, false)
      assert.equal(result.verification.compiled, false)
      assert.match(
        result.verification.reason,
        /No Lean formalization was written/,
      )
      assert.equal(calls.length, 0)
      await assert.rejects(manager.apply('alice', result.id), { status: 409 })
    })
})

test('Formalize explains unexpected document or scratch changes and blocks applying them', async (t) => {
  const { manager, calls, execute } = await fixture(t, async (workspace) => {
    await fs.writeFile(
      path.join(workspace, 'Main.lean'),
      'theorem from_document : True := by trivial\n',
    )
    await fs.writeFile(
      path.join(workspace, 'paper.txt'),
      'Extraction scratch text\n',
    )
  })
  const result = await execute('Formalize the paper.', {
    mode: 'formalize',
    liveEdits: false,
  })
  assert.equal(result.verification.complete, false)
  assert.match(
    result.verification.errors[0],
    /Keep paper.txt unchanged.*scratch output outside the project/,
  )
  assert.equal(calls.length, 0)
  await assert.rejects(manager.apply('alice', result.id), { status: 409 })
})

test(
  'explicit live editing saves text changes during the turn and can undo creations, renames, and deletions',
  { timeout: 15000 },
  async (t) => {
    let observedLive = false
    const { manager, workspaces, project, calls, events, requests, execute } =
      await fixture(t, async (workspace) => {
        await fs.writeFile(
          path.join(workspace, 'Notes.md'),
          '# Updated notes\n',
        )
        await fs.rename(
          path.join(workspace, 'Old.txt'),
          path.join(workspace, 'Renamed.txt'),
        )
        await fs.unlink(path.join(workspace, 'Obsolete.txt'))
        await fs.writeFile(path.join(workspace, 'Summary.md'), '# Summary\n')
        const deadline = Date.now() + 5000
        while (
          (await workspaces.readFile(project.id, 'alice', 'Notes.md'))
            .content !== '# Updated notes\n'
        ) {
          assert(
            Date.now() < deadline,
            'Text edits should reach the saved project while the turn is running',
          )
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.equal(events.list('alice', project.id)[0].status, 'running')
        observedLive = true
      })
    for (const file of ['Notes.md', 'Old.txt', 'Obsolete.txt'])
      await workspaces.writeFile(project.id, 'alice', file, 'Original\n', null)
    const result = await execute('Update and organize the notes.', {
      liveEdits: true,
    })
    assert.equal(result.status, 'completed', result.error)
    assert(observedLive)
    assert.equal(result.liveEdits, true)
    assert.equal(result.verification.complete, true)
    assert.equal(result.verification.kind, 'workspace')
    assert.equal(result.liveChanges.length, 5)
    assert.equal(
      calls.length,
      0,
      'Text live edits do not need Lean verification',
    )
    assert.match(
      requests.find((request) => request.method === 'thread/start').params
        .developerInstructions,
      /Editing mode: live source updates/,
    )
    assert.equal(
      (await workspaces.readFile(project.id, 'alice', 'Summary.md')).content,
      '# Summary\n',
    )
    await manager.apply('alice', result.id)
    await manager.undo('alice', result.id)
    for (const file of ['Notes.md', 'Old.txt', 'Obsolete.txt'])
      assert.equal(
        (await workspaces.readFile(project.id, 'alice', file)).content,
        'Original\n',
      )
    for (const file of ['Renamed.txt', 'Summary.md'])
      await assert.rejects(workspaces.readFile(project.id, 'alice', file), {
        status: 404,
      })
  },
)

test(
  'live text edits preserve later user writes, including recreation of a deleted file',
  { timeout: 15000 },
  async (t) => {
    for (const deleted of [false, true])
      await t.test(
        deleted ? 'recreated deletion' : 'edited notes',
        async (t) => {
          const { manager, workspaces, project, execute } = await fixture(
            t,
            (workspace) =>
              deleted
                ? fs.unlink(path.join(workspace, 'Notes.md'))
                : fs.writeFile(
                    path.join(workspace, 'Notes.md'),
                    'Agent update\n',
                  ),
          )
          await workspaces.writeFile(
            project.id,
            'alice',
            'Notes.md',
            'Original\n',
            null,
          )
          const result = await execute('Update the notes.', { liveEdits: true })
          assert.equal(result.verification.complete, true, result.error)
          await workspaces.writeFile(
            project.id,
            'alice',
            'Notes.md',
            'User update\n',
          )
          await assert.rejects(manager.apply('alice', result.id), {
            status: 409,
          })
          await assert.rejects(manager.undo('alice', result.id), {
            status: 409,
          })
          assert.equal(
            (await workspaces.readFile(project.id, 'alice', 'Notes.md'))
              .content,
            'User update\n',
          )
        },
      )
  },
)

test(
  'live Lean edits still require independent verification and remain undoable when checks fail',
  { timeout: 15000 },
  async (t) => {
    const { manager, workspaces, project, calls, execute } = await fixture(
      t,
      async (workspace) => {
        await fs.writeFile(
          path.join(workspace, 'Main.lean'),
          'theorem broken : False := by rfl\n',
        )
        await fs.writeFile(
          path.join(workspace, 'Notes.md'),
          '# Work in progress\n',
        )
      },
      { buildFails: true },
    )
    const original = await workspaces.readFile(project.id, 'alice', 'Main.lean')
    const result = await execute('Update the proof and notes.', {
      liveEdits: true,
    })
    assert.equal(result.status, 'completed', result.error)
    assert.equal(result.verification.complete, false)
    assert.equal(result.liveChanges.length, 2)
    assert.deepEqual(
      calls.map((call) => call.args.slice(0, 2)),
      [
        ['lake', 'env'],
        ['lake', 'build'],
      ],
    )
    await assert.rejects(manager.apply('alice', result.id), { status: 409 })
    await manager.undo('alice', result.id)
    assert.deepEqual(
      await workspaces.readFile(project.id, 'alice', 'Main.lean'),
      original,
    )
    await assert.rejects(workspaces.readFile(project.id, 'alice', 'Notes.md'), {
      status: 404,
    })
  },
)

test(
  'general questions need no proof target or Lean check and leave the saved project unchanged',
  { timeout: 15000 },
  async (t) => {
    const { workspaces, project, calls, requests, execute } = await fixture(t)
    const original = await workspaces.readFile(project.id, 'alice', 'Main.lean')
    const result = await execute('Help me plan a study schedule.')
    assert.equal(result.status, 'completed', result.error)
    assert.equal(result.liveEdits, false)
    assert.equal(result.verification.kind, 'chat')
    assert.equal(result.verification.compiled, undefined)
    assert.deepEqual(result.changes, [])
    assert.deepEqual(
      await workspaces.readFile(project.id, 'alice', 'Main.lean'),
      original,
    )
    assert.equal(
      calls.length,
      0,
      'Conversation must not start Lean verification',
    )
    const input = requests.find((request) => request.method === 'turn/start')
      .params.input[0].text
    assert(input.includes('Help me plan a study schedule.'))
    const instructions = requests.find(
      (request) => request.method === 'thread/start',
    ).params.developerInstructions
    assert.match(instructions, /primary purpose is helping users/)
    assert.match(instructions, /general questions, writing/)
    assert.doesNotMatch(instructions, /Search mode is read-only/)
    const thread = requests.find(
      (request) => request.method === 'thread/start',
    ).params
    assert.equal(thread.sandbox, 'danger-full-access')
    assert.equal(thread.approvalPolicy, 'never')
    assert.match(instructions, /workspace shell/)
  },
)

test(
  'Ask & Search creates, edits, renames, and deletes text files through review before apply',
  { timeout: 15000 },
  async (t) => {
    const { manager, workspaces, project, calls, execute } = await fixture(
      t,
      async (workspace) => {
        await fs.writeFile(
          path.join(workspace, 'Notes.md'),
          '# Organized notes\n',
        )
        await fs.rename(
          path.join(workspace, 'Old.txt'),
          path.join(workspace, 'Renamed.txt'),
        )
        await fs.unlink(path.join(workspace, 'Obsolete.txt'))
        await fs.writeFile(path.join(workspace, 'Summary.md'), '# Summary\n')
      },
    )
    for (const file of ['Notes.md', 'Old.txt', 'Obsolete.txt'])
      await workspaces.writeFile(
        project.id,
        'alice',
        file,
        'Original notes\n',
        null,
      )
    const result = await execute(
      'Organize my notes, rename Old.txt, delete Obsolete.txt, and create Summary.md.',
    )
    assert.equal(result.status, 'completed', result.error)
    assert.equal(result.liveEdits, false)
    assert.equal(result.verification.kind, 'workspace')
    assert.equal(result.verification.complete, true)
    assert.equal(result.verification.kernelChecked, undefined)
    assert.equal(
      calls.length,
      0,
      'Text-only file work must not start Lean verification',
    )
    assert.equal(
      (await workspaces.readFile(project.id, 'alice', 'Notes.md')).content,
      'Original notes\n',
    )
    await assert.rejects(
      workspaces.readFile(project.id, 'alice', 'Summary.md'),
      { status: 404 },
    )
    assert.equal(
      await fs.readFile(
        path.join(result.verificationRoot, 'Summary.md'),
        'utf8',
      ),
      '# Summary\n',
    )
    await assert.rejects(
      fs.stat(path.join(result.verificationRoot, 'Obsolete.txt')),
      { code: 'ENOENT' },
    )
    await manager.apply('alice', result.id)
    assert.equal(
      (await workspaces.readFile(project.id, 'alice', 'Notes.md')).content,
      '# Organized notes\n',
    )
    assert.equal(
      (await workspaces.readFile(project.id, 'alice', 'Renamed.txt')).content,
      'Original notes\n',
    )
    assert.equal(
      (await workspaces.readFile(project.id, 'alice', 'Summary.md')).content,
      '# Summary\n',
    )
    for (const file of ['Old.txt', 'Obsolete.txt'])
      await assert.rejects(workspaces.readFile(project.id, 'alice', file), {
        status: 404,
      })
  },
)

test(
  'Ask & Search cannot overwrite concurrent saved text edits when applying a candidate',
  { timeout: 15000 },
  async (t) => {
    const { manager, workspaces, project, execute } = await fixture(
      t,
      (workspace) =>
        fs.writeFile(path.join(workspace, 'Notes.md'), 'Agent candidate\n'),
    )
    await workspaces.writeFile(
      project.id,
      'alice',
      'Notes.md',
      'Baseline\n',
      null,
    )
    const result = await execute('Update Notes.md.')
    assert.equal(result.verification.complete, true)
    await workspaces.writeFile(
      project.id,
      'alice',
      'Notes.md',
      'My concurrent edit\n',
    )
    await assert.rejects(manager.apply('alice', result.id), { status: 409 })
    assert.equal(
      (await workspaces.readFile(project.id, 'alice', 'Notes.md')).content,
      'My concurrent edit\n',
    )
  },
)

test(
  'mixed Lean and text changes retain independent proof verification and block invalid proofs',
  { timeout: 15000 },
  async (t) => {
    for (const buildFails of [false, true])
      await t.test(buildFails ? 'invalid Lean' : 'valid Lean', async (t) => {
        const { manager, workspaces, project, calls, execute } = await fixture(
          t,
          async (workspace) => {
            await fs.writeFile(
              path.join(workspace, 'Main.lean'),
              buildFails
                ? 'theorem target : False := by rfl\n'
                : 'theorem target : True := by trivial\n',
            )
            await fs.writeFile(
              path.join(workspace, 'Notes.md'),
              '# Proof notes\n',
            )
          },
          { buildFails },
        )
        const original = await workspaces.readFile(
          project.id,
          'alice',
          'Main.lean',
        )
        const result = await execute(
          'Update the Lean example and add proof notes.',
        )
        assert.equal(result.status, 'completed', result.error)
        assert.equal(result.verification.complete, !buildFails)
        assert.deepEqual(
          await workspaces.readFile(project.id, 'alice', 'Main.lean'),
          original,
        )
        assert.deepEqual(
          calls.slice(0, 2).map((call) => call.args.slice(0, 2)),
          [
            ['lake', 'env'],
            ['lake', 'build'],
          ],
        )
        assert(
          calls.every(
            (call) =>
              call.workspace === result.verificationRoot &&
              call.options.network === 'none',
          ),
        )
        if (buildFails) {
          await assert.rejects(manager.apply('alice', result.id), {
            status: 409,
          })
        } else {
          assert.equal(result.verification.kernelChecked, true)
          assert.equal(calls.length, 3)
          await manager.apply('alice', result.id)
          assert.equal(
            (await workspaces.readFile(project.id, 'alice', 'Notes.md'))
              .content,
            '# Proof notes\n',
          )
        }
      })
  },
)

test(
  'Ask & Search blocks pinned configuration changes and Lean trust bypasses',
  { timeout: 15000 },
  async (t) => {
    for (const [file, source] of [
      ['lean-toolchain', 'leanprover/lean4:v4.35.0\n'],
      ['lakefile.toml', 'name = "changed"\n'],
      ['Main.lean', 'axiom forged : False\n'],
    ])
      await t.test(file, async (t) => {
        const { manager, workspaces, project, calls, execute } = await fixture(
          t,
          (workspace) => fs.writeFile(path.join(workspace, file), source),
        )
        const original = await workspaces.readFile(
          project.id,
          'alice',
          'Main.lean',
        )
        const result = await execute('Change the project file.')
        assert.equal(result.status, 'completed', result.error)
        assert.equal(result.verification.complete, false)
        assert.equal(calls.length, 0)
        await assert.rejects(manager.apply('alice', result.id), { status: 409 })
        assert.deepEqual(
          await workspaces.readFile(project.id, 'alice', 'Main.lean'),
          original,
        )
      })
  },
)

test(
  'general candidate verification preserves containment, protected paths, and live-edit policy',
  { timeout: 15000 },
  async (t) => {
    const { workspaces, project } = await fixture(t)
    const snapshot = await workspaces.snapshot(
      project.id,
      'alice',
      'containment',
    )
    const textChange = {
      path: 'Notes.md',
      before: null,
      beforeHash: null,
      after: '# Notes\n',
    }
    await assert.rejects(
      workspaces.verificationCopy(snapshot, [textChange]),
      /Lean source files only/,
    )
    await assert.rejects(
      workspaces.syncLive(snapshot, [textChange]),
      /Lean source files only/,
    )
    for (const filename of [
      '../escaped.txt',
      '.env',
      '.git/config',
      '.lake/packages/pkg/Notes.md',
      'Nested/lean-toolchain',
      'lakefile.toml',
    ])
      await assert.rejects(
        workspaces.verificationCopy(
          snapshot,
          [{ ...textChange, path: filename }],
          { allowProjectFiles: true },
        ),
      )
    for (const after of ['bad\0text', 5])
      await assert.rejects(
        workspaces.verificationCopy(snapshot, [{ ...textChange, after }], {
          allowProjectFiles: true,
        }),
      )
    await assert.rejects(
      workspaces.verificationCopy(
        snapshot,
        [{ ...textChange, beforeHash: 'f'.repeat(64) }],
        { allowProjectFiles: true },
      ),
      /Original baseline/,
    )
  },
)
