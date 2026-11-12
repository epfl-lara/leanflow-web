#!/usr/bin/env node
// Real HTTP/auth, Yjs transport, Docker workers, Lean and PTY. No inference.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import JSZip from 'jszip'
import { createSharingLiveFixture } from './lib/sharing-live-fixture.mjs'

const directory = path.resolve(
  '.runtime/sharing-validation',
  `native-${randomUUID()}`,
)
const reportPath = path.resolve(
  '.runtime/sharing-validation/runtime-report.json',
)
const report = {
  passed: false,
  providerCalls: 0,
  workerImage: null,
  checks: [],
  failures: [],
}
const sockets = new Set()
let fixture
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
const sh = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`
async function json(actor, endpoint, options = {}) {
  const response = await fixture.request(actor, endpoint, options)
  const value = await response.json()
  assert(response.ok, `${response.status} ${endpoint}: ${value.error}`)
  return value
}
async function connect(actor, kind = 'terminal', target = fixture.project.id) {
  const socket = new WebSocket(
    fixture.origin.replace('http:', 'ws:') +
      (kind === 'lean'
        ? `/websocket/${target}`
        : `/websocket/${kind}/${target}`),
    {
      headers: {
        Authorization: `Bearer ${fixture.accounts[actor].token}`,
        Origin: fixture.origin,
      },
    },
  )
  sockets.add(socket)
  socket.on('error', () => {})
  socket.once('close', () => sockets.delete(socket))
  return socket
}
async function terminal(actor = 'editorA') {
  const socket = await connect(actor)
  let output = ''
  const packets = []
  socket.on('message', (data, binary) => {
    if (binary) {
      output = (output + data.toString()).slice(-2 * 1024 * 1024)
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: 'ack', bytes: data.length }))
    } else packets.push(JSON.parse(data.toString()))
  })
  await until(
    () => output.includes('/workspace') || socket.readyState === 3,
    'real terminal prompt',
    60_000,
  )
  assert.equal(
    socket.readyState,
    1,
    `Terminal closed: ${JSON.stringify(packets)}`,
  )
  const send = (data) => socket.send(JSON.stringify({ type: 'input', data }))
  send('stty -echo\r')
  send("printf '%s%s\\n' 'SHELL_' 'READY'\r")
  await until(() => output.includes('SHELL_READY'), 'non-echo shell setup')
  return {
    socket,
    send,
    packets,
    get output() {
      return output
    },
  }
}
async function stopTerminal(actor = 'editorA') {
  const started = Date.now()
  await json(actor, `/api/projects/${fixture.project.id}/terminal/stop`, {
    method: 'POST',
    body: {},
  })
  assert(
    Date.now() - started < 15_000,
    'Terminal stop exceeded bounded cleanup time',
  )
}
const source = async (name = 'Main.lean', actor = 'admin') =>
  json(
    actor,
    `/api/projects/${fixture.project.id}/file?path=${encodeURIComponent(name)}`,
  )
async function save(content, name = 'Main.lean', actor = 'admin') {
  let previous
  try {
    previous = await source(name, actor)
  } catch {
    previous = { hash: null }
  }
  return json(
    actor,
    `/api/projects/${fixture.project.id}/file?path=${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      body: { content, expectedHash: previous.hash },
    },
  )
}
async function record(name, fn) {
  const started = Date.now()
  await fn()
  report.checks.push({ name, durationMs: Date.now() - started })
  console.log(`PASS ${name}`)
}

try {
  fixture = await createSharingLiveFixture({ directory })
  report.workerImage = fixture.runtime.imageId
  await fixture.studio.gitConnections.setIdentity(fixture.accounts.admin.id, {
    name: 'Private Admin Identity',
    email: 'admin@fixture.invalid',
  })
  await fixture.studio.gitConnections.setIdentity(fixture.accounts.editorA.id, {
    name: 'Native Editor Identity',
    email: 'editor@fixture.invalid',
  })
  await fixture.studio.gitConnections.connect(fixture.accounts.admin.id, {
    host: 'github.com',
    provider: 'github',
    token: 'NATIVE_ADMIN_GIT_FIXTURE_TOKEN',
  })
  await fixture.studio.gitConnections.connect(fixture.accounts.editorA.id, {
    host: 'github.com',
    provider: 'github',
    token: 'NATIVE_EDITOR_GIT_FIXTURE_TOKEN',
  })
  const originalHome = await fixture.runtime.home(fixture.project.root)
  await fs.writeFile(
    path.join(originalHome, 'PRIVATE_ADMIN_HOME'),
    'not shared',
  )
  await record(
    'editor real PTY uses selected private copy and own Git identity without other projects or provider keys',
    async () => {
      const term = await terminal()
      const worker = [...fixture.runtime.children].find((child) =>
        child.workspaceRoot.startsWith(
          path.join(fixture.dataDir, 'candidates') + path.sep,
        ),
      )
      assert(worker, 'Terminal worker mounts an isolated candidate')
      assert.notEqual(worker.workspaceRoot, fixture.project.root)
      const runId = path.basename(path.dirname(worker.workspaceRoot))
      assert.equal(
        (await json('editorA', '/api/terminal-recoveries')).some(
          (copy) => copy.runId === runId,
        ),
        false,
        'An open PTY is not a closed recovery copy',
      )
      const discard = await fixture.request(
        'editorA',
        `/api/projects/${fixture.project.id}/terminal-recoveries/${runId}`,
        { method: 'DELETE', body: {} },
      )
      assert.equal(discard.status, 409)
      await discard.text()
      const inspected = await promisify(execFile)('docker', [
        'inspect',
        '--format',
        '{{json .Mounts}}',
        worker.containerName,
      ])
      const mounts = JSON.parse(inspected.stdout)
      assert.equal(
        mounts.find((mount) => mount.Destination === '/workspace').Source,
        worker.workspaceRoot,
      )
      assert.equal(
        mounts.some(
          (mount) =>
            mount.Destination === '/repository' ||
            mount.Source === fixture.dataDir ||
            mount.Source.startsWith(fixture.privateProject.root),
        ),
        false,
      )
      assert.notEqual(
        mounts.find((mount) => mount.Destination === '/home/worker').Source,
        originalHome,
      )
      const probe = `import os,pathlib,subprocess\nassert pathlib.Path('/workspace/Main.lean').exists()\nassert not pathlib.Path(${JSON.stringify(fixture.privateProject.root)}).exists()\nassert not pathlib.Path('/home/worker/PRIVATE_ADMIN_HOME').exists()\nassert not pathlib.Path('/home/worker/.lemex/auth.json').exists()\nassert not any(k in os.environ for k in ['LEMEX_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY'])\nassert subprocess.check_output(['git','config','user.name'],text=True).strip() == 'Native Editor Identity'\ncredentials = subprocess.check_output(['git','credential','fill'], input='protocol=https\\nhost=github.com\\npath=fixture/repo\\n\\n', text=True)\nassert 'password=NATIVE_EDITOR_GIT_FIXTURE_TOKEN' in credentials\nassert 'NATIVE_ADMIN_GIT_FIXTURE_TOKEN' not in credentials\nprint('ISOLATION_'+'OK')`
      term.send(`python3 -I -c ${sh(probe)}\r`)
      await until(
        () => term.output.includes('ISOLATION_OK'),
        'private PTY isolation and actor Git identity',
      )
      await stopTerminal()
      assert.equal(fixture.runtime.children.size, 0)
    },
  )

  await record(
    'rapid cancellation during terminal copy startup releases workers and allows reopening',
    async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const socket = await connect('editorA')
        await until(
          () => socket.readyState === 1 || socket.readyState === 3,
          'startup connection',
        )
        assert.equal(socket.readyState, 1)
        socket.send(
          JSON.stringify({
            type: 'input',
            data: "printf 'STARTUP_CHECK\\n'\r",
          }),
        )
        if (attempt % 2) await wait(20)
        socket.close()
        await stopTerminal()
        assert.equal(fixture.runtime.children.size, 0)
      }
      const entries = await fs.readdir(fixture.studio.workspaces.snapshotsDir)
      assert.deepEqual(
        entries,
        [],
        'Aborted private copies are not retained as phantom recoveries',
      )
      const term = await terminal()
      assert.equal(term.socket.readyState, 1)
      await stopTerminal()
    },
  )

  const viewer = await connect('viewer', 'collaboration')
  const viewerDoc = new Y.Doc()
  const viewedDocuments = new Map([['Main.lean', viewerDoc]])
  const viewerPackets = []
  viewer.on('message', (data) => {
    const message = JSON.parse(data.toString())
    viewerPackets.push(message)
    if (message.type === 'document') {
      let doc = viewedDocuments.get(message.path)
      if (!doc) {
        doc = new Y.Doc()
        viewedDocuments.set(message.path, doc)
      }
      Y.applyUpdate(doc, Buffer.from(message.update, 'base64'))
    }
  })
  await until(() => viewer.readyState === 1, 'viewer live connection')
  viewer.send(JSON.stringify({ type: 'open', path: 'Main.lean' }))
  await until(
    () => viewerDoc.getText('source').length > 0,
    'viewer source state',
  )
  await record(
    'viewer real Lean session cannot use metaprogram IO to modify saved project files',
    async () => {
      const baseline = await source()
      const socket = await connect('viewer', 'lean')
      const messages = []
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())))
      await until(
        () => socket.readyState === 1,
        'viewer Lean session websocket',
      )
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            processId: null,
            rootUri: 'file:///workspace',
            capabilities: {},
          },
        }),
      )
      await until(
        () => messages.some((message) => message.id === 1),
        'real Lean initialize',
        45_000,
      )
      assert(
        messages.find((message) => message.id === 1).result,
        'Lean initialization succeeds',
      )
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }),
      )
      const worker = [...fixture.runtime.children].find(
        (child) => child.workspaceRoot === fixture.project.root,
      )
      assert(worker, 'Viewer Lean worker selected the shared project')
      const inspected = await promisify(execFile)('docker', [
        'inspect',
        '--format',
        '{{json .Mounts}}',
        worker.containerName,
      ])
      const mounts = JSON.parse(inspected.stdout)
      assert.equal(
        mounts.find((mount) => mount.Destination === '/workspace').RW,
        false,
      )
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri: 'file:///workspace/Main.lean',
              languageId: 'lean4',
              version: 1,
              text: 'import Lean\n#eval IO.FS.writeFile "/workspace/VIEWER_FORBIDDEN.txt" "forbidden"\n',
            },
          },
        }),
      )
      await until(
        () =>
          messages.some(
            (message) =>
              message.method === 'textDocument/publishDiagnostics' &&
              message.params?.diagnostics?.some((entry) =>
                /read-only|permission denied/i.test(entry.message),
              ),
          ),
        'Lean metaprogram filesystem write rejection',
        45_000,
      )
      await assert.rejects(
        fs.stat(path.join(fixture.project.root, 'VIEWER_FORBIDDEN.txt')),
        { code: 'ENOENT' },
      )
      assert.equal((await source()).hash, baseline.hash)
      socket.close()
      await until(
        () => fixture.runtime.children.size === 0,
        'viewer Lean worker cleanup',
      )
    },
  )

  await record(
    'real shell edits reach the viewer and final publication rejects discard after the worker exits',
    async () => {
      const term = await terminal()
      term.send(
        `python3 -I -c ${sh("from pathlib import Path; p=Path('Main.lean'); p.write_text(p.read_text()+'-- NATIVE_TERMINAL_CHANGE\\n')")}\r`,
      )
      await until(
        async () => (await source()).content.includes('NATIVE_TERMINAL_CHANGE'),
        'durable terminal file publication',
      )
      await until(
        () =>
          viewerDoc
            .getText('source')
            .toString()
            .includes('NATIVE_TERMINAL_CHANGE'),
        'viewer sees terminal file publication',
      )
      const worker = [...fixture.runtime.children].find((child) =>
        child.workspaceRoot.startsWith(
          path.join(fixture.dataDir, 'candidates') + path.sep,
        ),
      )
      assert(worker)
      const runId = path.basename(path.dirname(worker.workspaceRoot))
      const workspaces = fixture.studio.workspaces
      const originalChanges = workspaces.changes
      let entered = false,
        release
      const pending = new Promise((resolve) => (release = resolve))
      workspaces.changes = async function (snapshot, ...options) {
        if (
          snapshot.runId === runId &&
          this.terminalCopies.get(runId)?.phase === 'finalizing'
        ) {
          entered = true
          await pending
        }
        return originalChanges.call(this, snapshot, ...options)
      }
      const stopping = stopTerminal()
      stopping.catch(() => {})
      try {
        await until(() => entered, 'real PTY final publication scan')
        assert.equal(
          fixture.runtime.children.size,
          0,
          'The real worker stopped before its final publication',
        )
        assert.equal(
          (await json('editorA', '/api/terminal-recoveries')).some(
            (copy) => copy.runId === runId,
          ),
          false,
        )
        const discard = await fixture.request(
          'editorA',
          `/api/projects/${fixture.project.id}/terminal-recoveries/${runId}`,
          { method: 'DELETE', body: {} },
        )
        assert.equal(
          discard.status,
          409,
          'A final scan cannot be discarded after the worker exits',
        )
        await discard.text()
      } finally {
        release()
        try {
          await stopping
        } finally {
          workspaces.changes = originalChanges
        }
      }
      assert.equal(
        (
          await json(
            'editorA',
            `/api/projects/${fixture.project.id}/terminal-recoveries`,
          )
        ).length,
        0,
      )
    },
  )

  await record(
    'real lake build keeps generated artifacts private and saved Lean check succeeds',
    async () => {
      const term = await terminal()
      term.send("lake build && printf '%s%s\\n' 'NATIVE_BUILD_' 'OK'\r")
      await until(
        () =>
          term.output.includes('NATIVE_BUILD_OK') ||
          term.output.includes('error:'),
        'native lake build',
        90_000,
      )
      assert(term.output.includes('NATIVE_BUILD_OK'), term.output.slice(-1500))
      await stopTerminal()
      assert.equal(
        (
          await json(
            'editorA',
            `/api/projects/${fixture.project.id}/terminal-recoveries`,
          )
        ).length,
        0,
      )
      const files = await json(
        'viewer',
        `/api/projects/${fixture.project.id}/files`,
      )
      assert.equal(
        files.some(
          (file) => /\.(?:olean|ilean|c|o)$/.test(file.path) && !file.readOnly,
        ),
        false,
      )
      const job = await json(
        'editorB',
        `/api/projects/${fixture.project.id}/check`,
        { method: 'POST', body: { path: 'Main.lean' } },
      )
      await until(
        async () =>
          ['completed', 'failed', 'cancelled'].includes(
            (await json('editorB', `/api/jobs/${job.id}`)).status,
          ),
        'real saved-project Lean check',
        120_000,
      )
      const completed = await json('editorB', `/api/jobs/${job.id}`)
      assert.equal(completed.status, 'completed', completed.error)
      assert.equal(fixture.runtime.children.size, 0)
    },
  )

  await record(
    'agent publication path uses a real isolated candidate and Lean compilation without inference',
    async () => {
      const snapshot = await fixture.studio.workspaces.snapshot(
        fixture.project.id,
        fixture.accounts.editorB.id,
        randomUUID(),
      )
      const main = await fs.readFile(
        path.join(snapshot.root, 'Main.lean'),
        'utf8',
      )
      await fs.writeFile(
        path.join(snapshot.root, 'Main.lean'),
        main + '-- DETERMINISTIC_AGENT_EDIT\n',
      )
      const built = await fixture.runtime.run(
        snapshot.root,
        ['lake', 'build'],
        {
          network: 'none',
          freshHome: true,
          cleanHome: true,
          timeoutMs: 90_000,
        },
      )
      assert.equal(built.code, 0, built.stderr)
      const changes = await fixture.studio.workspaces.changes(snapshot)
      await fixture.studio.workspaces.syncLive(snapshot, changes)
      await until(
        () =>
          viewerDoc
            .getText('source')
            .toString()
            .includes('DETERMINISTIC_AGENT_EDIT'),
        'viewer sees checked candidate publication',
      )
      assert((await source()).content.includes('DETERMINISTIC_AGENT_EDIT'))
      await fixture.runtime.clearInheritedDependencies(snapshot.root, {
        force: true,
      })
      await fs.rm(path.dirname(snapshot.root), { recursive: true, force: true })
    },
  )

  await record(
    'actual Lean check rejects imported sources changed while its worker is running',
    async () => {
      await save('def nativeValue : Nat := 7\n', 'Main/Other.lean')
      const main =
        'import Main.Other\n#eval IO.sleep 3000\nexample : nativeValue = 7 := rfl\n'
      await save(main)
      const job = await json(
        'editorB',
        `/api/projects/${fixture.project.id}/check`,
        { method: 'POST', body: { path: 'Main.lean' } },
      )
      await until(
        async () =>
          (await json('editorB', `/api/jobs/${job.id}`)).status === 'running' &&
          fixture.runtime.children.size > 0,
        'running real imported-source checker',
      )
      await save('def nativeValue : Nat := 8\n', 'Main/Other.lean')
      await until(
        async () =>
          ['completed', 'failed', 'cancelled'].includes(
            (await json('editorB', `/api/jobs/${job.id}`)).status,
          ),
        'changed-source check conclusion',
        120_000,
      )
      const checked = await json('editorB', `/api/jobs/${job.id}`)
      assert.equal(checked.status, 'failed')
      assert.equal(checked.result.sourceChanged, true)
      await save('def nativeValue : Nat := 7\n', 'Main/Other.lean')
      await save('import Main.Other\nexample : nativeValue = 7 := rfl\n')
    },
  )

  let recoveryRun
  await record(
    'simultaneous collaborator save preserves shell conflict copy and limits recovery to its caller',
    async () => {
      const term = await terminal()
      const baseline = (await source()).content
      await save(baseline + '-- HUMAN_WINS\n')
      term.send(
        `python3 -I -c ${sh("from pathlib import Path; p=Path('Main.lean'); p.write_text(p.read_text()+'-- PRIVATE_SHELL_DRAFT\\n')")}\r`,
      )
      await until(
        () => term.output.includes('File updates paused:'),
        'terminal CAS conflict notification',
      )
      assert((await source()).content.includes('HUMAN_WINS'))
      assert.equal(
        (await source()).content.includes('PRIVATE_SHELL_DRAFT'),
        false,
      )
      await stopTerminal()
      const recoveries = await json(
        'editorA',
        `/api/projects/${fixture.project.id}/terminal-recoveries`,
      )
      assert.equal(recoveries.length, 1)
      recoveryRun = recoveries[0].runId
      const archive = await fixture.request(
        'editorA',
        `/api/projects/${fixture.project.id}/terminal-recoveries/${recoveryRun}/download`,
      )
      assert.equal(archive.status, 200)
      const zip = await JSZip.loadAsync(
        Buffer.from(await archive.arrayBuffer()),
      )
      assert(
        (await zip.file('Main.lean').async('string')).includes(
          'PRIVATE_SHELL_DRAFT',
        ),
      )
      for (const actor of ['admin', 'editorB', 'viewer', 'outsider'])
        assert.equal(
          (
            await fixture.request(
              actor,
              `/api/projects/${fixture.project.id}/terminal-recoveries/${recoveryRun}/download`,
            )
          ).status,
          404,
        )
    },
  )

  await record(
    'terminal configuration publication respects another member active work and preserves its draft',
    async () => {
      const originalMain = (await source()).content
      await save(
        'import Main.Other\n#eval IO.sleep 4000\nexample : nativeValue = 7 := rfl\n',
      )
      const term = await terminal()
      const before = await source('lakefile.toml')
      const checking = await json(
        'editorB',
        `/api/projects/${fixture.project.id}/check`,
        { method: 'POST', body: { path: 'Main.lean' } },
      )
      await until(
        async () =>
          (await json('editorB', `/api/jobs/${checking.id}`)).status ===
          'running',
        'another member real active check',
      )
      term.send("printf '\\n# PRIVATE_CONFIGURATION\\n' >> lakefile.toml\r")
      await until(
        () => term.output.includes('File updates paused:'),
        'active-work configuration rejection',
      )
      assert.equal((await source('lakefile.toml')).hash, before.hash)
      assert.equal(
        (await json('editorB', `/api/jobs/${checking.id}`)).status,
        'running',
      )
      await stopTerminal()
      await until(
        async () =>
          ['completed', 'failed', 'cancelled'].includes(
            (await json('editorB', `/api/jobs/${checking.id}`)).status,
          ),
        'active check survives blocked terminal config',
        120_000,
      )
      const checked = await json('editorB', `/api/jobs/${checking.id}`)
      assert.equal(
        checked.status,
        'completed',
        JSON.stringify(checked.result || checked.error),
      )
      await save(originalMain)
      const recoveries = await json(
        'editorA',
        `/api/projects/${fixture.project.id}/terminal-recoveries`,
      )
      assert.equal(recoveries.length, 2)
    },
  )

  await record(
    'binary output remains private and recoverable while current and later text edits keep publishing',
    async () => {
      const term = await terminal()
      const binary =
        "from pathlib import Path; Path('Generated.png').write_bytes(bytes([137,80,78,71,0,1,2,3])); Path('BinaryDraft.lean').write_text('-- retained binary-associated draft\\n')"
      term.send(`python3 -I -c ${sh(binary)}\r`)
      await until(
        () => term.output.includes('Text changes continue to publish.'),
        'non-pausing binary recovery notice',
      )
      await until(
        async () =>
          (await source('BinaryDraft.lean')).content.includes(
            'retained binary-associated draft',
          ),
        'text publication beside binary output',
      )
      viewer.send(JSON.stringify({ type: 'open', path: 'BinaryDraft.lean' }))
      await until(
        () =>
          viewedDocuments
            .get('BinaryDraft.lean')
            ?.getText('source')
            .toString()
            .includes('retained binary-associated draft'),
        'viewer sees text beside private binary',
      )
      term.send("printf '\\n-- SECOND_TEXT_CHANGE\\n' >> BinaryDraft.lean\r")
      await until(
        async () =>
          (await source('BinaryDraft.lean')).content.includes(
            'SECOND_TEXT_CHANGE',
          ),
        'later terminal text continues publishing',
      )
      await until(
        () =>
          viewedDocuments
            .get('BinaryDraft.lean')
            ?.getText('source')
            .toString()
            .includes('SECOND_TEXT_CHANGE'),
        'viewer sees later terminal text',
      )
      assert.equal(term.output.includes('File updates paused:'), false)
      const absent = await fixture.request(
        'admin',
        `/api/projects/${fixture.project.id}/file?path=Generated.png`,
      )
      assert.equal(absent.status, 404)
      await absent.text()
      await stopTerminal()
      const recoveries = await json(
        'editorA',
        `/api/projects/${fixture.project.id}/terminal-recoveries`,
      )
      const found = recoveries.find((entry) =>
        /Generated.png/.test(entry.message),
      )
      assert(found, 'binary output has an explicit recovery receipt')
      const response = await fixture.request(
        'editorA',
        `/api/projects/${fixture.project.id}/terminal-recoveries/${found.runId}/download`,
      )
      assert.equal(response.status, 200)
      const zip = await JSZip.loadAsync(
        Buffer.from(await response.arrayBuffer()),
      )
      assert.equal(
        (await zip.file('Generated.png').async('uint8array')).length,
        8,
      )
      assert(
        (await zip.file('BinaryDraft.lean').async('string')).includes(
          'retained binary-associated draft',
        ),
      )
    },
  )

  await record(
    'revoke during an active shell closes its worker without publishing later private writes',
    async () => {
      const term = await terminal()
      term.send("sleep 8; printf 'LATE_PRIVATE_WRITE\\n' > Revoked.txt\r")
      const started = Date.now()
      await json(
        'admin',
        `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorA.id}`,
        { method: 'DELETE', body: {} },
      )
      assert(
        Date.now() - started < 15_000,
        'Revocation waited too long for worker cancellation',
      )
      await until(
        () =>
          term.socket.readyState === 3 && fixture.runtime.children.size === 0,
        'revoked terminal cleanup',
      )
      const response = await fixture.request(
        'admin',
        `/api/projects/${fixture.project.id}/file?path=Revoked.txt`,
      )
      assert.equal(response.status, 404)
      await response.text()
      assert.equal(
        (
          await fixture.request(
            'editorA',
            `/api/projects/${fixture.project.id}`,
          )
        ).status,
        404,
      )
      assert.equal(
        (
          await fixture.request(
            'editorA',
            `/api/projects/${fixture.project.id}/terminal-recoveries/${recoveryRun}/download`,
          )
        ).status,
        200,
      )
    },
  )

  await record(
    'durable recovery and memberships survive an isolated server restart',
    async () => {
      viewer.close()
      for (const doc of viewedDocuments.values()) doc.destroy()
      await fixture.restart()
      assert.equal(
        (
          await fixture.request(
            'editorA',
            `/api/projects/${fixture.project.id}`,
          )
        ).status,
        404,
      )
      assert.equal(
        (await fixture.request('viewer', `/api/projects/${fixture.project.id}`))
          .status,
        200,
      )
      const recoveries = await json(
        'editorA',
        `/api/projects/${fixture.project.id}/terminal-recoveries`,
      )
      assert(recoveries.some((entry) => entry.runId === recoveryRun))
      const response = await fixture.request(
        'editorA',
        `/api/projects/${fixture.project.id}/terminal-recoveries/${recoveryRun}/download`,
      )
      assert.equal(response.status, 200)
      await response.arrayBuffer()
      assert.equal(fixture.runtime.children.size, 0)
    },
  )
  report.passed = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await fixture?.close()
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
