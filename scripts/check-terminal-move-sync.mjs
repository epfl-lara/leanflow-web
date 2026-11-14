#!/usr/bin/env node
// Real isolated Docker PTYs, HTTP/auth and workspace synchronization; no inference.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import JSZip from 'jszip'
import { createSharingLiveFixture } from './lib/sharing-live-fixture.mjs'
import { until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/terminal-move-sync')
const directory = path.join(output, `fixture-${randomUUID()}`)
await fs.mkdir(output, { recursive: true })
const report = {
  passed: false,
  cleanupComplete: false,
  providerCalls: 0,
  toolchain: 'leanprover/lean4:v4.34.1',
  checks: [],
}
await fs.writeFile(
  path.join(output, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
)
const originalFetch = globalThis.fetch
globalThis.fetch = (input, options) => {
  const url =
    typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url
  if (url.startsWith('https://provider.example/')) {
    report.providerCalls++
    throw new Error('Provider requests are disabled for this terminal check.')
  }
  return originalFetch(input, options)
}
const sockets = new Set()
const terminals = []
const theorem = 'Problems/Problem1_16.lean'
let fixture, releaseSync
const sh = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`
const python = (code) => `python3 -I -c ${sh(code)}`
const waitForFiles = (condition) =>
  python(`import pathlib,time,os
deadline=time.monotonic()+15
while time.monotonic()<deadline:
    try:
        if ${condition}: break
    except (FileNotFoundError,NotADirectoryError):
        pass
    time.sleep(0.1)
else: raise AssertionError('Terminal files did not synchronize')`)
const record = async (name, task) => {
  const start = Date.now()
  await task()
  report.checks.push({ name, durationMs: Date.now() - start })
  console.log(`PASS ${name}`)
}

try {
  assert(
    process.env.STUDIO_TEST_WORKER_IMAGE || process.env.LEMEX_WORKER_IMAGE,
    'Set STUDIO_TEST_WORKER_IMAGE to the deployed worker image before running this check.',
  )
  fixture = await createSharingLiveFixture({ directory })
  report.workerImage = fixture.runtime.imageId
  const prefix = `/api/projects/${fixture.project.id}`
  const json = async (actor, endpoint, options = {}) => {
    const response = await fixture.request(actor, endpoint, options)
    const value = await response.json()
    assert(response.ok, `${response.status}: ${value.error || endpoint}`)
    return value
  }
  const source = (filename) =>
    json('admin', `${prefix}/file?path=${encodeURIComponent(filename)}`)
  const optionalSource = async (filename) => {
    const response = await fixture.request(
      'admin',
      `${prefix}/file?path=${encodeURIComponent(filename)}`,
    )
    const value = await response.json()
    if (response.status === 404) return null
    assert.equal(response.status, 200, value.error)
    return value.content
  }
  const save = async (filename, content) => {
    let expectedHash = null
    try {
      expectedHash = (await source(filename)).hash
    } catch {
      /* New fixture file. */
    }
    return json(
      'admin',
      `${prefix}/file?path=${encodeURIComponent(filename)}`,
      {
        method: 'PUT',
        body: { content, expectedHash },
      },
    )
  }
  for (const [filename, content] of Object.entries({
    'Problems/Problem1_16_figure.svg':
      '<svg xmlns="http://www.w3.org/2000/svg"><!-- terminal move fixture --></svg>\n',
    'Problems/Problem1_16.lean':
      '-- [Diagram](Problem1_16_figure.svg)\nexample : True := by trivial\n',
    'README.md': '![Diagram](Problems/Problem1_16_figure.svg)\n',
    'Proofs/Helper.lean': 'theorem helper : True := by trivial\n',
    'Proofs/Main.lean': 'import Proofs.Helper\nexample : True := by trivial\n',
    'Use.lean': 'import Proofs.Main\n',
    'Uncertain/A.svg': '<svg><!-- copied instead of renamed --></svg>\n',
    'Uncertain/Use.lean': '-- [Diagram](A.svg)\n',
    'Scratch.lean': '-- baseline for conflict recovery\n',
  }))
    await save(filename, content)
  for (const name of ['Problems/figures', 'Archive'])
    await json('admin', `${prefix}/folders`, {
      method: 'POST',
      body: { path: name },
    })

  const terminal = async (actor) => {
    const before = new Set(fixture.runtime.children)
    const socket = new WebSocket(
      fixture.origin.replace('http:', 'ws:') +
        `/websocket/terminal/${fixture.project.id}`,
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
    let output = ''
    const packets = []
    socket.on('message', (data, binary) => {
      if (binary) {
        output = (output + data.toString()).slice(-1024 * 1024)
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: 'ack', bytes: data.length }))
      } else packets.push(JSON.parse(data.toString()))
    })
    await until(
      () =>
        output.includes('/workspace') || socket.readyState === WebSocket.CLOSED,
      'real private terminal prompt',
      60_000,
    )
    assert.equal(socket.readyState, WebSocket.OPEN, JSON.stringify(packets))
    const send = (data) => socket.send(JSON.stringify({ type: 'input', data }))
    send("stty -echo; printf '%s%s\\n' 'TERMINAL_' 'READY'\r")
    await until(
      () => output.includes('TERMINAL_READY'),
      'non-echo terminal setup',
    )
    const worker = [...fixture.runtime.children].find(
      (child) => !before.has(child) && child.workspaceRoot,
    )
    assert(worker, 'The terminal must have its own real worker.')
    return {
      actor,
      socket,
      packets,
      root: worker.workspaceRoot,
      get output() {
        return output
      },
      async command(command) {
        const id = randomUUID().replaceAll('-', '')
        const marker = `COMMAND_${id}`
        send(`${command}; printf '\\n%s%s:%s\\n' 'COMMAND_' '${id}' "$?"\r`)
        await until(
          () =>
            output.includes(marker + ':') ||
            socket.readyState === WebSocket.CLOSED,
          'terminal command result',
          20_000,
        )
        const result = output.match(new RegExp(`${marker}:(\\d+)`))
        assert(
          result,
          `Terminal stopped before command completed: ${JSON.stringify(packets)}`,
        )
        assert.equal(Number(result[1]), 0, output.slice(-2500))
      },
    }
  }
  const first = await terminal('editorA')
  terminals.push(first)
  const second = await terminal('editorB')
  terminals.push(second)
  const pauseNextSync = async (term) => {
    const sync = fixture.studio.workspaces.syncTerminal.bind(
      fixture.studio.workspaces,
    )
    let held = false,
      release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const paused = async (...args) => {
      if (!held && args[0].root === term.root) {
        held = true
        await gate
      }
      return sync(...args)
    }
    fixture.studio.workspaces.syncTerminal = paused
    releaseSync = () => {
      release()
      if (fixture.studio.workspaces.syncTerminal === paused)
        fixture.studio.workspaces.syncTerminal = sync
    }
    await until(() => held, 'held private synchronization')
    return releaseSync
  }
  const assertBoth = async (condition) => {
    for (const term of [first, second])
      await term.command(waitForFiles(condition))
  }
  await record(
    'An unchanged open PTY receives a shared SVG move and its exact Lean diagram reference',
    async () => {
      await json('editorB', `${prefix}/move`, {
        method: 'POST',
        body: {
          from: 'Problems/Problem1_16_figure.svg',
          to: 'Problems/figures/Problem1_16_figure.svg',
          updateReferences: true,
        },
      })
      assert.match(
        (await source(theorem)).content,
        /-- \[Diagram\]\(figures\/Problem1_16_figure\.svg\)/,
      )
      await assertBoth(
        "pathlib.Path('Problems/figures/Problem1_16_figure.svg').is_file() and not pathlib.Path('Problems/Problem1_16_figure.svg').exists() and '-- [Diagram](figures/Problem1_16_figure.svg)' in pathlib.Path('Problems/Problem1_16.lean').read_text()",
      )
    },
  )
  await record(
    'Web updates keep an existing terminal file readable while its contents change',
    async () => {
      const baseline = (await source(theorem)).content
      const reading = first.command(
        python(`import pathlib,time
source=pathlib.Path('Problems/Problem1_16.lean')
missing=0
deadline=time.monotonic()+3
while time.monotonic()<deadline:
    try: source.read_text()
    except FileNotFoundError: missing+=1
    time.sleep(0.001)
assert missing==0, f'Terminal source disappeared {missing} times during web saves'`),
      )
      const writing = (async () => {
        for (let index = 0; index < 12; index++) {
          await save(
            theorem,
            baseline + `-- private read continuity ${index}\n`,
          )
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
      })()
      const results = await Promise.allSettled([reading, writing])
      for (const result of results)
        if (result.status === 'rejected') throw result.reason
      await assertBoth(
        "'-- private read continuity 11' in pathlib.Path('Problems/Problem1_16.lean').read_text()",
      )
      report.leaseCompaction = {}
      for (const term of [first, second]) {
        const runId = path.basename(path.dirname(term.root))
        const copy = fixture.studio.workspaces.terminalCopies.get(runId)
        assert(copy?.reconciliation)
        await until(
          () => copy.reconciliation.backups.length === 0,
          `kernel lease compaction for ${term.actor}`,
          15_000,
        )
        report.leaseCompaction[term.actor] = copy.reconciliation.backups.length
      }
    },
  )
  await record(
    'Actual terminal mv updates the diagram reference in shared and both private copies',
    async () => {
      await first.command(
        'mv Problems/figures/Problem1_16_figure.svg Problems/Problem1_16_figure.svg',
      )
      await until(
        async () =>
          (await source(theorem)).content.includes(
            '-- [Diagram](Problem1_16_figure.svg)',
          ),
        'terminal move reference publication',
        20_000,
      )
      await assertBoth(
        "pathlib.Path('Problems/Problem1_16_figure.svg').is_file() and not pathlib.Path('Problems/figures/Problem1_16_figure.svg').exists() and '-- [Diagram](Problem1_16_figure.svg)' in pathlib.Path('Problems/Problem1_16.lean').read_text()",
      )
      assert.equal(
        (await source('README.md')).content,
        '![Diagram](Problems/Problem1_16_figure.svg)\n',
      )
    },
  )
  await record(
    'A shared folder move preserves an existing shell cwd and synchronizes rewritten imports',
    async () => {
      await second.command('cd Proofs')
      await json('editorA', `${prefix}/move`, {
        method: 'POST',
        body: { from: 'Proofs', to: 'Archive/Proofs', updateReferences: true },
      })
      await second.command(
        waitForFiles(
          "os.getcwd() == '/workspace/Archive/Proofs' and pathlib.Path('Main.lean').is_file() and 'import Archive.Proofs.Helper' in pathlib.Path('Main.lean').read_text()",
        ),
      )
      await second.command('cd /workspace')
      await assertBoth(
        "pathlib.Path('Archive/Proofs/Main.lean').is_file() and not pathlib.Path('Proofs').exists() and 'import Archive.Proofs.Main' in pathlib.Path('Use.lean').read_text()",
      )
    },
  )
  await record(
    'A later terminal folder move updates imports and does not revert on another synchronization',
    async () => {
      await second.command('cd Archive/Proofs')
      await first.command('mv Archive/Proofs Archive/Results')
      await until(
        async () =>
          (await source('Use.lean')).content.includes(
            'import Archive.Results.Main',
          ),
        'terminal folder import update',
        20_000,
      )
      await second.command(
        waitForFiles(
          "os.getcwd() == '/workspace/Archive/Results' and 'import Archive.Results.Helper' in pathlib.Path('Main.lean').read_text()",
        ),
      )
      await second.command('cd /workspace')
      await assertBoth(
        "pathlib.Path('Archive/Results/Main.lean').is_file() and not pathlib.Path('Archive/Proofs').exists() and 'import Archive.Results.Helper' in pathlib.Path('Archive/Results/Main.lean').read_text()",
      )
      const current = await source(theorem)
      await save(theorem, current.content + '-- later browser edit\n')
      await assertBoth(
        "'-- later browser edit' in pathlib.Path('Problems/Problem1_16.lean').read_text()",
      )
      await second.command(
        "printf '%s\\n' '-- terminal B after browser edit' >> Problems/Problem1_16.lean",
      )
      await until(
        async () => {
          const content = (await source(theorem)).content
          return (
            content.includes('-- later browser edit') &&
            content.includes('-- terminal B after browser edit')
          )
        },
        'successive browser and terminal changes',
        20_000,
      )
      await first.command(
        waitForFiles(
          "'-- terminal B after browser edit' in pathlib.Path('Problems/Problem1_16.lean').read_text()",
        ),
      )
      assert.match(
        (await source('Use.lean')).content,
        /import Archive\.Results\.Main/,
      )
    },
  )
  await record(
    'An open terminal can reuse its own deleted and moved paths while peers keep receiving changes',
    async () => {
      const waitSaved = (filename, marker) =>
        until(
          async () => (await optionalSource(filename))?.includes(marker),
          `saved ${filename}`,
          20_000,
        )
      const waitRemoved = (filename) =>
        until(
          async () => (await optionalSource(filename)) === null,
          `removed ${filename}`,
          20_000,
        )
      await first.command(
        "mkdir -p Temporary; printf '%s\\n' '-- OWN_ORIGINAL' > Temporary/A.lean",
      )
      await waitSaved('Temporary/A.lean', 'OWN_ORIGINAL')
      await first.command(
        python("import pathlib; pathlib.Path('Temporary/A.lean').unlink()"),
      )
      await waitRemoved('Temporary/A.lean')
      await first.command(
        "mkdir -p Temporary; printf '%s\\n' '-- OWN_RECREATED' > Temporary/A.lean",
      )
      await waitSaved('Temporary/A.lean', 'OWN_RECREATED')
      await second.command(
        waitForFiles(
          "'OWN_RECREATED' in pathlib.Path('Temporary/A.lean').read_text()",
        ),
      )

      await first.command('mv Temporary/A.lean Temporary/Moved.lean')
      await waitSaved('Temporary/Moved.lean', 'OWN_RECREATED')
      await waitRemoved('Temporary/A.lean')
      await first.command(
        "printf '%s\\n' '-- OWN_NEW_OLD_PATH' > Temporary/A.lean",
      )
      await waitSaved('Temporary/A.lean', 'OWN_NEW_OLD_PATH')
      await second.command(
        waitForFiles(
          "'OWN_NEW_OLD_PATH' in pathlib.Path('Temporary/A.lean').read_text() and 'OWN_RECREATED' in pathlib.Path('Temporary/Moved.lean').read_text()",
        ),
      )

      await first.command(
        "mkdir -p Temporary/Folder; printf '%s\\n' '-- OWN_FOLDER_MEMBER' > Temporary/Folder/Original.lean",
      )
      await waitSaved('Temporary/Folder/Original.lean', 'OWN_FOLDER_MEMBER')
      await first.command('mv Temporary/Folder Temporary/MovedFolder')
      await waitSaved(
        'Temporary/MovedFolder/Original.lean',
        'OWN_FOLDER_MEMBER',
      )
      await waitRemoved('Temporary/Folder/Original.lean')
      await first.command(
        "mkdir -p Temporary/Folder; printf '%s\\n' '-- OWN_NEW_CHILD' > Temporary/Folder/New.lean",
      )
      await waitSaved('Temporary/Folder/New.lean', 'OWN_NEW_CHILD')
      await first.command(
        "printf '%s\\n' '-- OWN_TYPING_STILL_SAVES' >> Temporary/Folder/New.lean",
      )
      await waitSaved('Temporary/Folder/New.lean', 'OWN_TYPING_STILL_SAVES')
      await second.command(
        waitForFiles(
          "'OWN_TYPING_STILL_SAVES' in pathlib.Path('Temporary/Folder/New.lean').read_text() and pathlib.Path('Temporary/MovedFolder/Original.lean').is_file()",
        ),
      )
      for (const term of [first, second])
        assert.notEqual(
          term.packets.filter((packet) => packet.type === 'sync').at(-1)?.state,
          'paused',
        )
      await first.command(python("import shutil; shutil.rmtree('Temporary')"))
      await waitRemoved('Temporary/A.lean')
      await waitRemoved('Temporary/Folder/New.lean')
      await waitRemoved('Temporary/MovedFolder/Original.lean')
      await second.command(
        waitForFiles("not pathlib.Path('Temporary').exists()"),
      )
    },
  )
  await record(
    'Terminal file moves merge into a populated destination without replacing its existing files',
    async () => {
      await first.command(
        "mkdir -p MergeOld MergeNew; printf '%s\\n' '-- MERGE_SOURCE_A' > MergeOld/A.lean; printf '%s\\n' '-- MERGE_SOURCE_B' > MergeOld/B.lean; printf '%s\\n' '-- MERGE_EXISTING_KEPT' > MergeNew/Existing.lean",
      )
      for (const filename of [
        'MergeOld/A.lean',
        'MergeOld/B.lean',
        'MergeNew/Existing.lean',
      ])
        await until(
          async () => (await optionalSource(filename)) !== null,
          `saved ${filename}`,
          20_000,
        )
      await assertBoth(
        "pathlib.Path('MergeOld/A.lean').is_file() and pathlib.Path('MergeOld/B.lean').is_file() and 'MERGE_EXISTING_KEPT' in pathlib.Path('MergeNew/Existing.lean').read_text()",
      )
      await first.command(
        'mv MergeOld/A.lean MergeOld/B.lean MergeNew/ && rmdir MergeOld',
      )
      for (const [filename, marker] of [
        ['MergeNew/A.lean', 'MERGE_SOURCE_A'],
        ['MergeNew/B.lean', 'MERGE_SOURCE_B'],
        ['MergeNew/Existing.lean', 'MERGE_EXISTING_KEPT'],
      ])
        await until(
          async () => (await optionalSource(filename))?.includes(marker),
          `merged ${filename}`,
          20_000,
        )
      assert.equal(
        (await source('MergeNew/Existing.lean')).content,
        '-- MERGE_EXISTING_KEPT\n',
      )
      await assertBoth(
        "not pathlib.Path('MergeOld').exists() and 'MERGE_SOURCE_A' in pathlib.Path('MergeNew/A.lean').read_text() and 'MERGE_SOURCE_B' in pathlib.Path('MergeNew/B.lean').read_text() and pathlib.Path('MergeNew/Existing.lean').read_text() == '-- MERGE_EXISTING_KEPT\\n'",
      )
      await first.command(python("import shutil; shutil.rmtree('MergeNew')"))
      await until(
        async () => (await optionalSource('MergeNew/Existing.lean')) === null,
        'removed populated move fixture',
        20_000,
      )
      await second.command(
        waitForFiles(
          "not pathlib.Path('MergeOld').exists() and not pathlib.Path('MergeNew').exists()",
        ),
      )
    },
  )
  await record(
    'An unproven copy-and-delete move shows a persistent warning without blocking later source saves',
    async () => {
      const release = await pauseNextSync(second)
      await second.command(
        python(
          "import pathlib,shutil; shutil.copyfile('Uncertain/A.svg','Uncertain/B.svg'); pathlib.Path('Uncertain/A.svg').unlink()",
        ),
      )
      release()
      await until(
        () =>
          second.packets.some(
            (packet) =>
              packet.type === 'sync' &&
              packet.state === 'limited' &&
              /moves|imports|links/.test(packet.message),
          ),
        'terminal reference warning',
        20_000,
      )
      assert.equal(
        (await source('Uncertain/Use.lean')).content,
        '-- [Diagram](A.svg)\n',
      )
      await second.command(
        "printf '%s\\n' '-- WARNING_DOES_NOT_BLOCK_SAVING' >> Other.lean",
      )
      await until(
        async () =>
          (await source('Other.lean')).content.includes(
            'WARNING_DOES_NOT_BLOCK_SAVING',
          ),
        'later source publication with a warning',
        20_000,
      )
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const latest = second.packets
        .filter((packet) => packet.type === 'sync')
        .at(-1)
      assert.equal(latest.state, 'limited')
      assert.match(latest.message, /moves|imports|links/)
    },
  )
  await record(
    'Concurrent private changes are preserved instead of overwritten by a shared file update',
    async () => {
      const release = await pauseNextSync(first)
      await first.command(
        "printf '%s\\n' '-- PRIVATE_TERMINAL_DRAFT' > Scratch.lean",
      )
      await save('Scratch.lean', '-- NEWER_SHARED_SOURCE\n')
      release()
      await until(
        () =>
          first.packets.some(
            (packet) => packet.type === 'sync' && packet.state === 'paused',
          ) || /File updates paused/.test(first.output),
        'private conflict notification',
        20_000,
      )
      assert.equal(
        (await source('Scratch.lean')).content,
        '-- NEWER_SHARED_SOURCE\n',
      )
      await first.command(
        python(
          "import pathlib; assert pathlib.Path('Scratch.lean').read_text() == '-- PRIVATE_TERMINAL_DRAFT\\n'",
        ),
      )
      await json('editorA', `${prefix}/terminal/stop`, {
        method: 'POST',
        body: {},
      })
      const recoveries = await json('editorA', `${prefix}/terminal-recoveries`)
      assert.equal(recoveries.length, 1)
      const response = await fixture.request(
        'editorA',
        `${prefix}/terminal-recoveries/${recoveries[0].runId}/download`,
      )
      assert.equal(response.status, 200)
      const archive = await JSZip.loadAsync(await response.arrayBuffer())
      const recovered = Object.values(archive.files).find((file) =>
        file.name.endsWith('Scratch.lean'),
      )
      assert(recovered)
      assert.equal(
        await recovered.async('string'),
        '-- PRIVATE_TERMINAL_DRAFT\n',
      )
    },
  )
  await record(
    'Revoking the remaining terminal account closes its PTY and rejects later project writes',
    async () => {
      await json(
        'admin',
        `${prefix}/sharing/members/${fixture.accounts.editorB.id}`,
        {
          method: 'DELETE',
          body: {},
        },
      )
      await until(
        () => second.socket.readyState === WebSocket.CLOSED,
        'revoked terminal closure',
        20_000,
      )
      const denied = await fixture.request('editorB', `${prefix}/move`, {
        method: 'POST',
        body: { from: 'Archive/Results', to: 'Proofs', updateReferences: true },
      })
      assert.equal(denied.status, 404)
    },
  )
  assert.equal(report.providerCalls, 0)
  report.passed = true
} catch (error) {
  report.error = error.stack || String(error)
  report.terminals = await Promise.all(
    terminals.map(async (term) => ({
      actor: term.actor,
      sync: term.packets.filter((packet) => packet.type === 'sync').slice(-5),
      outputTail: term.output.slice(-700),
      diagram: await fs
        .readFile(path.join(term.root, theorem), 'utf8')
        .catch((failure) => failure.message),
    })),
  )
  throw error
} finally {
  releaseSync?.()
  for (const socket of sockets) socket.terminate()
  try {
    await fixture?.close()
    report.cleanupComplete = true
  } catch (error) {
    report.cleanupError = error.message
    report.passed = false
    process.exitCode = 1
  }
  globalThis.fetch = originalFetch
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
}
