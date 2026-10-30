import { runPinnedLake } from './pinned-lake.mjs'

const DEFAULT_TIMEOUT_MS = 180_000
const WORKER_TIME_MARGIN_MS = 5_000
const MAX_SOURCE_FILES = 4096
const MAX_DEPS_OUTPUT_BYTES = 64 * 1024
const MAX_WORKER_OUTPUT_BYTES = 256 * 1024
const WORKSPACE = '/workspace'

// Import headers are inspected inside the isolated worker. The project source
// is never compiled or evaluated here: --deps only resolves the modules that
// editor imports need, so unfinished proofs and `sorry` bodies stay irrelevant.
const workerScript = String.raw`
import json, os, pathlib, re, stat, subprocess, sys, time

config = json.loads(sys.argv[1])
workspace = pathlib.Path(config.get('workspace') or '/workspace')
max_files = int(config['maxFiles'])
max_output = int(config['maxOutputBytes'])
deadline = time.monotonic() + float(config['deadlineMs']) / 1000
sysroot = os.environ.get('LEAN_SYSROOT', '')
lean = str(pathlib.Path(sysroot) / 'bin/lean') if re.match(r'^/opt/lean-toolchains/[^/]+$', sysroot) else 'lean'

def clip(value, limit=700):
    value = ' '.join(str(value).split())
    return value if len(value) <= limit else value[:limit - 3] + '...'

def finish(ready, message, modules=None):
    result = {'ready': bool(ready), 'message': clip(message)}
    if modules is not None:
        result['modules'] = modules
    print(json.dumps(result))
    sys.exit(0)

def timed_out():
    finish(False, 'The import check did not finish within its time limit. Rebuild the project and retry.')

def relative_name(file):
    try:
        return str(file.relative_to(workspace))
    except ValueError:
        return str(file)

def walk_sources():
    sources = []
    scan_errors = []
    try:
        workspace_info = workspace.lstat()
    except OSError:
        finish(False, 'The project workspace could not be read while checking imports. Refresh setup and retry.')
    if not stat.S_ISDIR(workspace_info.st_mode):
        finish(False, 'The project workspace is unavailable while checking imports. Refresh setup and retry.')
    pending = [workspace]
    while pending:
        if time.monotonic() > deadline:
            timed_out()
        directory = pending.pop()
        try:
            entries = os.scandir(directory)
        except OSError as error:
            scan_errors.append(error)
            continue
        with entries:
            for entry in entries:
                if time.monotonic() > deadline:
                    timed_out()
                if entry.name.startswith('.') or entry.name == 'lakefile.lean':
                    continue
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(pathlib.Path(entry.path))
                        continue
                    if not entry.name.endswith('.lean'):
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        continue
                except OSError as error:
                    scan_errors.append(error)
                    continue
                sources.append(pathlib.Path(entry.path))
                if len(sources) > max_files:
                    finish(False, 'The project has too many Lean files to import-check at once. Reduce the project size and retry.')
    if scan_errors:
        finish(False, 'Some project files could not be read while checking imports. Check the project files and retry.')
    return sources

def compiler_detail(proc):
    lines = []
    for stream in (proc.stderr, proc.stdout):
        for line in (stream or '').splitlines():
            line = line.strip()
            if line:
                lines.append(line)
    return clip(' '.join(lines[-4:]), 400)

def missing_module(detail):
    for pattern, group in (
        (r"object file ['\"][^'\"]+\.olean['\"] of module ([^\s]+) does not exist", 1),
        (r"unknown module prefix ['\"]([^'\"]+)['\"]", 1),
        (r"(?:could not|failed to) (?:resolve|find) import ['\"]([^'\"]+)['\"]", 1),
    ):
        match = re.search(pattern, detail, re.IGNORECASE)
        if match:
            return match.group(group)
    return None

def olean_module(file):
    name = file.with_suffix('')
    try:
        parts = list(name.relative_to(workspace).parts)
    except ValueError:
        parts = list(name.parts)
    for index in range(len(parts) - 1, -1, -1):
        if parts[index] == 'lean':
            parts = parts[index + 1:]
            break
    return '.'.join(parts) or name.name

def inspect(file):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        timed_out()
    try:
        proc = subprocess.run(
            [lean, '--deps', str(file)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=min(30, remaining),
        )
    except FileNotFoundError:
        finish(False, 'The pinned Lean compiler is unavailable, so project imports could not be checked. Refresh setup and retry.')
    except OSError:
        finish(False, 'The pinned Lean compiler could not be started, so project imports could not be checked. Refresh setup and retry.')
    except subprocess.TimeoutExpired:
        timed_out()
    if len(proc.stdout or '') + len(proc.stderr or '') > max_output:
        finish(False, 'The import check produced too much compiler output and was stopped. Rebuild the project and retry.')
    detail = compiler_detail(proc)
    name = relative_name(file)
    if proc.returncode != 0:
        module = missing_module(detail)
        if module:
            finish(False, 'The project imports are not ready: ' + name + ' imports ' + module + ', but its compiled module is missing or unavailable. Rebuild the project, then retry.')
        finish(False, 'The project imports are not ready: Lean could not resolve the imports in ' + name + '. Rebuild the project or use Refresh setup, then retry.' + (' ' + detail if detail else ''))
    for line in (proc.stdout or '').splitlines():
        dependency = line.strip()
        if not dependency or not dependency.endswith('.olean'):
            continue
        dependency_path = pathlib.Path(dependency)
        if not dependency_path.is_absolute():
            dependency_path = workspace / dependency_path
        try:
            available = dependency_path.is_file()
        except OSError:
            available = False
        if not available:
            module = olean_module(dependency_path)
            finish(False, 'The project imports are not ready: ' + name + ' imports ' + module + ', but its compiled module is missing. Rebuild the project, then retry.')

sources = walk_sources()
if config.get('collectImports'):
    if not sources:
        finish(True, 'No local Lean imports.', [])
    try:
        proc = subprocess.run(
            [lean, '--deps-json', '--stdin'],
            input='\n'.join(str(source) for source in sources) + '\n',
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace',
            timeout=max(0.001, deadline - time.monotonic()),
        )
        if proc.returncode or len(proc.stdout) > 4 * 1024 * 1024:
            finish(False, 'Could not inspect project import headers with the pinned Lean compiler. Use Refresh setup and inspect the setup output.')
        report = json.loads(proc.stdout)
        headers = report['imports']
        if not isinstance(headers, list) or len(headers) != len(sources):
            raise ValueError('Invalid import header report')
        modules = set()
        for header in headers:
            # Malformed source headers remain editable; usable headers still
            # describe the dependency modules that can be prepared now.
            if header.get('errors'):
                continue
            for item in header['result']['imports']:
                name = item['module']
                if not isinstance(name, str):
                    raise ValueError('Invalid imported module')
                modules.add(name)
        if len(modules) > max_files:
            raise ValueError('Too many imported modules')
        finish(True, 'Project import headers inspected.', sorted(modules))
    except subprocess.TimeoutExpired:
        timed_out()
    except (OSError, ValueError, KeyError, TypeError):
        finish(False, 'Could not inspect project import headers with the pinned Lean compiler. Use Refresh setup and inspect the setup output.')
if not sources:
    finish(True, 'No local Lean source files need import checks; the project environment is ready.')
for source in sources:
    inspect(source)
finish(True, 'Project imports are ready (' + str(len(sources)) + ' Lean file' + ('' if len(sources) == 1 else 's') + ' checked).')
`

function validTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

function workerConfig(timeoutMs) {
  return JSON.stringify({
    workspace: WORKSPACE,
    maxFiles: MAX_SOURCE_FILES,
    maxOutputBytes: MAX_DEPS_OUTPUT_BYTES,
    deadlineMs: Math.max(
      1,
      timeoutMs - Math.min(WORKER_TIME_MARGIN_MS, Math.floor(timeoutMs / 4)),
    ),
  })
}

function workerCommand(timeoutMs) {
  return [
    'lake',
    'env',
    'python3',
    '-I',
    '-c',
    workerScript,
    workerConfig(timeoutMs),
  ]
}

function parseEditorImportResult(stdout) {
  if (typeof stdout !== 'string') return null
  const line = stdout.trim().split(/\r?\n/).at(-1)
  if (!line) return null
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.ready !== 'boolean' ||
    typeof value.message !== 'string'
  )
    return null
  const message = value.message.trim()
  if (!message || message.length > 2_000) return null
  return { ready: value.ready, message }
}

function cancelled(signal, result) {
  if (signal?.aborted) {
    throw signal.reason || new Error('The import check was cancelled.')
  }
  if (result?.cancelled) throw new Error('The import check was cancelled.')
}

function failureMessage(result) {
  if (result?.timedOut)
    return 'The import check did not finish within its time limit. Rebuild the project and retry.'
  if (result?.truncated)
    return 'The import check produced too much output and was stopped. Rebuild the project and retry.'
  return 'The project import check could not finish. Rebuild the project and retry.'
}

function launchFailureMessage(error) {
  if (
    error?.pinnedEnvironment ||
    error?.unsupportedEnvironment ||
    error?.setupEnvironment
  )
    return error.message
  return 'The project import check could not start. Refresh setup and retry.'
}

export async function checkEditorImports(runtime, root, options = {}) {
  const { signal, onOutput } = options
  signal?.throwIfAborted()
  const timeoutMs = validTimeout(options.timeoutMs)
  let result
  try {
    result = await runPinnedLake(runtime, root, workerCommand(timeoutMs), {
      signal,
      onOutput,
      timeoutMs,
      network: 'none',
      cleanHome: true,
      readOnlyWorkspace: true,
      writeLakeCache: true,
      maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
    })
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error
    return { ready: false, message: launchFailureMessage(error) }
  }
  cancelled(signal, result)
  if (result?.code !== 0 || result?.truncated)
    return { ready: false, message: failureMessage(result) }
  const parsed = parseEditorImportResult(result?.stdout)
  if (!parsed)
    return {
      ready: false,
      message:
        'The project import check did not return a usable result. Rebuild the project and retry.',
    }
  return parsed
}

// Read headers before loading Lake or downloading packages. The compiler's
// parser handles comments and module syntax even when no oleans exist yet.
export async function projectImportRequirements(runtime, root, options = {}) {
  const { signal } = options
  signal?.throwIfAborted()
  const timeoutMs = validTimeout(options.timeoutMs)
  const config = JSON.parse(workerConfig(timeoutMs))
  config.collectImports = true
  const result = await runtime.run(
    root,
    ['python3', '-I', '-c', workerScript, JSON.stringify(config)],
    {
      signal,
      timeoutMs,
      network: 'none',
      cleanHome: true,
      readOnlyWorkspace: true,
      writeLakeCache: true,
      maxOutputBytes: 2 * 1024 * 1024,
    },
  )
  cancelled(signal, result)
  let report
  try {
    report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
  } catch {
    /* A failed compiler or malformed worker output cannot certify coverage. */
  }
  if (
    result.code !== 0 ||
    result.truncated ||
    report?.ready !== true ||
    !Array.isArray(report.modules) ||
    report.modules.length > MAX_SOURCE_FILES ||
    report.modules.some((name) => typeof name !== 'string' || name.length > 256)
  )
    throw Object.assign(
      new Error(
        'Could not inspect the project imports needed by its dependencies. Use Refresh setup and inspect Setup output if this repeats.',
      ),
      { setupEnvironment: true },
    )
  return [...new Set(report.modules)].sort()
}
