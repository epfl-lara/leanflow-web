import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const runner = fileURLToPath(
  new URL('../lean-project-check/run.py', import.meta.url),
)
const pinnedPrefix = '/opt/lean-toolchains/fixture'

// Execute the real orchestration with subprocesses intercepted. This neither
// needs an installed toolchain nor permits a fixture to launch Lean or Docker.
const harness = String.raw`
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

settings = json.loads(sys.argv[3])
project = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("project_check_runner", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
os.chdir(project)
os.environ.update({
    "HOME": str(project / "outer-home"),
    "LEAN_PATH": "/attacker/compiled-modules",
    "LEAN_SRC_PATH": "/attacker/source",
    "LEAN_NUM_THREADS": "3",
    "LEMEX_API_KEY": "fixture-credential-do-not-forward",
    "OPENAI_API_KEY": "fixture-credential-do-not-forward",
    "AWS_SECRET_ACCESS_KEY": "fixture-credential-do-not-forward",
})
calls = []
exports = []

def intercepted(command, **options):
    command = list(map(str, command))
    if command == ["lean", "--print-prefix"]:
        phase = "prefix"
    elif "--" in command:
        inner = command[command.index("--") + 1:]
        phase = "resolve" if inner[-1] == "resolve-deps" else "export"
    elif "preflight" in command:
        phase = "preflight"
    elif command[1:3] == ["check", "--from-export"]:
        phase = "check"
    else:
        raise AssertionError("Unexpected subprocess: " + repr(command))
    entry = {
        "phase": phase,
        "command": command,
        "env": options.get("env"),
        "cwd": str(options["cwd"]) if "cwd" in options else None,
    }
    calls.append(entry)
    if settings.get("raises") == phase:
        raise OSError("fixture subprocess could not start")
    if phase == "export":
        output = options["stdout"]
        exports.append(str(output.name))
        if not settings.get("emptyExport"):
            output.write(b'{"fixture":"declaration"}\n')
    return SimpleNamespace(
        returncode=settings.get("failures", {}).get(phase, 0),
        stdout=settings.get("prefix", "/opt/lean-toolchains/fixture") + "\n",
        stderr="",
    )

module.subprocess.run = intercepted
module.shutil.which = lambda command: "/usr/bin/bwrap" if command == "bwrap" else None
output, errors = io.StringIO(), io.StringIO()
raised = None
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
    try:
        result = module.main()
    except OSError as error:
        result = None
        raised = str(error)
print(json.dumps({
    "code": result,
    "raised": raised,
    "calls": calls,
    "exports": exports,
    "exportExists": [Path(exported).exists() for exported in exports],
    "exportDirectoryExists": [Path(exported).parent.exists() for exported in exports],
    "stdout": output.getvalue(),
    "stderr": errors.getvalue(),
    "helper": str(module.HELPER),
    "project": str(project.resolve()),
}))
`

async function runFixture(t, settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-runner-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  if (!settings.missingManifest)
    await fs.writeFile(path.join(root, 'lake-manifest.json'), '{}')
  if (!settings.missingCache) await fs.mkdir(path.join(root, '.lake'))
  const { stdout, stderr } = await execute(
    'python3',
    ['-I', '-c', harness, runner, root, JSON.stringify(settings)],
    { timeout: 15_000, maxBuffer: 1024 * 1024 },
  )
  assert.equal(stderr, '')
  return JSON.parse(stdout)
}

function innerCommand(call) {
  return call.command.slice(call.command.indexOf('--') + 1)
}

function containsSequence(values, expected) {
  return values.some((_, start) =>
    expected.every((value, index) => values[start + index] === value),
  )
}

function assertCleanExport(result) {
  assert.deepEqual(
    result.exportExists,
    result.exports.map(() => false),
  )
  assert.deepEqual(
    result.exportDirectoryExists,
    result.exports.map(() => false),
  )
}

test('project checking resolves and exports before preflight and native replay, then removes the export', async (t) => {
  const result = await runFixture(t)
  assert.equal(result.code, 0)
  assert.deepEqual(
    result.calls.map((call) => call.phase),
    ['prefix', 'resolve', 'export', 'preflight', 'check'],
  )
  const [, resolve, exported, preflight, checked] = result.calls
  assert.deepEqual(innerCommand(resolve), [
    `${pinnedPrefix}/bin/lake`,
    'resolve-deps',
  ])
  const helper = [
    `${pinnedPrefix}/bin/lean`,
    '--load-dynlib',
    `${pinnedPrefix}/lib/lean/libLake_shared.so`,
    '--run',
    result.helper,
  ]
  assert.deepEqual(innerCommand(exported), [...helper, 'export'])
  assert.deepEqual(preflight.command, [
    ...helper,
    'preflight',
    result.exports[0],
  ])
  assert.equal(preflight.cwd, path.dirname(result.helper))
  assert.deepEqual(checked.command, [
    `${pinnedPrefix}/bin/lake`,
    'check',
    '--from-export',
    result.exports[0],
  ])
  assert.equal(checked.cwd, result.project)
  assert(!checked.command.includes('--inadvisably-no-sandbox'))
  assertCleanExport(result)
})

test('failed dependency resolution, export, preflight or native replay cannot produce success or bypass a check', async (t) => {
  const phases = ['prefix', 'resolve', 'export', 'preflight', 'check']
  for (const phase of phases.slice(1)) {
    const result = await runFixture(t, { failures: { [phase]: 17 } })
    assert.equal(result.code, 17, phase)
    assert.deepEqual(
      result.calls.map((call) => call.phase),
      phases.slice(0, phases.indexOf(phase) + 1),
      phase,
    )
    assertCleanExport(result)
  }
  const empty = await runFixture(t, { emptyExport: true })
  assert.equal(empty.code, 1)
  assert.deepEqual(
    empty.calls.map((call) => call.phase),
    ['prefix', 'resolve', 'export'],
  )
  assert.match(empty.stderr, /no declarations/)
  assertCleanExport(empty)
})

test('a subprocess startup exception still removes the export and never starts native replay', async (t) => {
  for (const phase of ['export', 'preflight']) {
    const result = await runFixture(t, { raises: phase })
    assert.equal(result.code, null)
    assert.equal(result.raised, 'fixture subprocess could not start')
    assert.equal(result.calls.at(-1).phase, phase)
    assert(!result.calls.some((call) => call.phase === 'check'))
    assertCleanExport(result)
  }
})

test('signal exits retain the export-limit status and always clean the temporary export', async (t) => {
  for (const phase of ['resolve', 'export', 'preflight', 'check']) {
    const result = await runFixture(t, { failures: { [phase]: -25 } })
    assert.equal(result.code, 153, phase)
    assert.equal(result.calls.at(-1).phase, phase)
    assertCleanExport(result)
  }
})

test('project subprocesses receive only the pinned toolchain environment, without inherited modules or credentials', async (t) => {
  const result = await runFixture(t)
  for (const call of result.calls.slice(1)) {
    assert.deepEqual(Object.keys(call.env).sort(), [
      'HOME',
      'LEAN_ABORT_ON_PANIC',
      'LEAN_NUM_THREADS',
      'LEAN_PATH',
      'LEAN_SRC_PATH',
      'PATH',
    ])
    assert.equal(call.env.PATH, `${pinnedPrefix}/bin:/usr/bin:/bin`)
    assert.equal(call.env.LEAN_PATH, `${pinnedPrefix}/lib/lean`)
    assert.equal(call.env.LEAN_SRC_PATH, `${pinnedPrefix}/src/lean`)
    for (const key of ['LEAN_PATH', 'LEAN_SRC_PATH']) {
      assert(
        call.env[key].split(':').every((entry) => path.posix.isAbsolute(entry)),
      )
      assert(!call.env[key].split(':').includes(result.project))
    }
    assert.equal(call.env.LEAN_ABORT_ON_PANIC, '1')
    assert.equal(call.env.LEAN_NUM_THREADS, '3')
    assert(!JSON.stringify(call).includes('fixture-credential-do-not-forward'))
    assert(!JSON.stringify(call).includes('/attacker/'))
  }
})

test('untrusted project resolution and export run offline with masked homes, read-only source and only the private cache writable', async (t) => {
  const result = await runFixture(t)
  for (const call of result.calls.filter((call) =>
    ['resolve', 'export'].includes(call.phase),
  )) {
    const args = call.command.slice(0, call.command.indexOf('--'))
    assert.equal(args[0], '/usr/bin/bwrap')
    for (const sequence of [
      ['--ro-bind', '/', '/'],
      ['--tmpfs', '/home'],
      ['--tmpfs', '/root'],
      ['--tmpfs', '/tmp'],
      ['--tmpfs', '/run'],
      ['--tmpfs', '/var'],
      ['--ro-bind', result.project, result.project],
      ['--ro-bind', pinnedPrefix, pinnedPrefix],
      ['--ro-bind', path.dirname(result.helper), path.dirname(result.helper)],
      ['--bind', `${result.project}/.lake`, `${result.project}/.lake`],
      ['--setenv', 'HOME', '/tmp/home'],
      ['--chdir', result.project],
    ]) {
      assert(containsSequence(args, sequence), sequence.join(' '))
    }
    for (const option of [
      '--clearenv',
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
    ])
      assert(args.includes(option), option)
    assert(!args.includes('--share-net'))
    assert.equal(args.filter((arg) => arg === '--bind').length, 1)
    assert(!args.includes('--bind-try'))
    assert(!args.includes('--bind-data'))
  }
})

test('missing prepared dependencies and invalid pinned installations are rejected before project execution', async (t) => {
  for (const settings of [{ missingManifest: true }, { missingCache: true }]) {
    const result = await runFixture(t, settings)
    assert.equal(result.code, 2)
    assert.deepEqual(result.calls, [])
    assertCleanExport(result)
  }
  for (const prefix of [
    '',
    '/etc',
    '/opt/lean-toolchains/../../tmp',
    '/opt/lean-toolchains',
    '/opt/lean-toolchains/fixture/nested',
    'relative/toolchain',
    '/opt/lean-toolchains/fixture\n/other/toolchain',
  ]) {
    const result = await runFixture(t, { prefix })
    assert.equal(result.code, 2, JSON.stringify(prefix))
    assert.deepEqual(
      result.calls.map((call) => call.phase),
      ['prefix'],
    )
    assertCleanExport(result)
  }
  const failed = await runFixture(t, { failures: { prefix: 1 } })
  assert.equal(failed.code, 2)
  assert.deepEqual(
    failed.calls.map((call) => call.phase),
    ['prefix'],
  )
})
