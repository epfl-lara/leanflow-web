import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Local project measurements, not Arena scores or cross-version compatibility.
export const optimizationMethod =
  'lean-sync-command-heartbeats-v1; arena-proof-body-tokens-9c98a3a'
const operators = [
  ':=',
  '!=',
  '&&',
  '-.',
  '->',
  '←',
  '..',
  '...',
  '::',
  ':>',
  '<;>',
  ';;',
  '==',
  '||',
  '=>',
  '<=',
  '>=',
  '⁻¹',
  '?_',
]

/** Literal-aware nested comment scanning. Masking preserves UTF-16 offsets. */
function scan(source, maskLiterals = false) {
  let result = '',
    index = 0
  const append = (start, end, masked) => {
    const value = source.slice(start, end)
    result += masked ? value.replace(/[^\n\r]/g, ' ') : value
  }
  while (index < source.length) {
    const start = index
    if (source.startsWith('/-', index)) {
      let depth = 1
      index += 2
      while (index < source.length && depth) {
        if (source.startsWith('/-', index)) {
          depth++
          index += 2
        } else if (source.startsWith('-/', index)) {
          depth--
          index += 2
        } else index++
      }
      if (depth) throw new Error('Unterminated Lean block comment.')
      append(start, index, true)
    } else if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end
      append(start, index, true)
    } else {
      const raw = /^r(#+)?"/.exec(source.slice(index))
      if (raw) {
        const terminator = '"' + (raw[1] || '')
        const end = source.indexOf(terminator, index + raw[0].length)
        if (end < 0) throw new Error('Unterminated Lean raw string.')
        index = end + terminator.length
        append(start, index, maskLiterals)
      } else if (source[index] === '"') {
        index++
        let closed = false
        while (index < source.length) {
          if (source[index] === '\\') index += 2
          else if (source[index++] === '"') {
            closed = true
            break
          }
        }
        if (!closed) throw new Error('Unterminated Lean string.')
        append(start, index, maskLiterals)
      } else if (source[index] === '«') {
        const end = source.indexOf('»', index + 1)
        if (end < 0) throw new Error('Unterminated Lean quoted identifier.')
        index = end + 1
        append(start, index, maskLiterals)
      } else {
        const char =
          source[index] === "'" &&
          /^'(?:\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/u.exec(
            source.slice(index),
          )
        if (char) {
          index += char[0].length
          append(start, index, maskLiterals)
        } else result += source[index++]
      }
    }
  }
  return result
}

/** Mirrors the pinned Arena convention, including tabs and operator merging. */
export function proofTokenCount(body) {
  let count = 0
  // Python str.strip/splitlines whitespace, as used by the pinned tokenizer.
  const whitespace =
    '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
  const trim = (value) =>
    value.replace(new RegExp(`^${whitespace}+|${whitespace}+$`, 'g'), '')
  const text = trim(scan(body)),
    lines = [],
    breaks = new Set([10, 11, 12, 13, 28, 29, 30, 133, 8232, 8233])
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (!breaks.has(text.charCodeAt(index))) continue
    lines.push(text.slice(start, index))
    if (text[index] === '\r' && text[index + 1] === '\n') index++
    start = index + 1
  }
  lines.push(text.slice(start))
  for (const line of lines) {
    if (!trim(line)) continue
    const tokens = []
    let token = ''
    const flush = () => {
      if (token) {
        tokens.push(token)
        token = ''
      }
    }
    for (const char of line) {
      if (char === ' ') flush()
      else if (/[\p{L}\p{N}._']/u.test(char)) token += char
      else {
        flush()
        tokens.push(char)
      }
    }
    flush()
    let tokenized = tokens.join(' ')
    for (const operator of operators)
      tokenized = tokenized.split([...operator].join(' ')).join(operator)
    count += tokenized.split(' ').length
  }
  return count
}

/** Conservative conventional theorem/lemma command spans; Lean checks each tail. */
export function optimizationTheorems(source) {
  const masked = scan(source, true),
    comments = scan(source)
  if (/^\s*(?:module|prelude|mutual)\b/m.test(masked))
    throw new Error(
      'Module, prelude, and mutual declaration syntax is not supported for automatic measurement.',
    )
  const pattern =
    /^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:private|protected|noncomputable)\s+){0,8}(theorem|lemma)\s+([\p{L}_][\p{L}\p{N}_'.]*)/gmu
  const matches = [...masked.matchAll(pattern)]
  const occurrences = [
    ...masked.matchAll(/(?<![\p{L}\p{N}_'.])(?:theorem|lemma)\b/gu),
  ]
  if (matches.length !== occurrences.length)
    throw new Error(
      'Only conventional named theorem and lemma declarations are supported for automatic measurement.',
    )
  const result = []
  for (const match of matches) {
    if (/\bprivate\b/.test(match[0]))
      throw new Error('Private theorem names cannot be measured automatically.')
    let start = match.index,
      depth = 0,
      bodyStart = -1
    for (let i = match.index + match[0].length; i < masked.length; i++) {
      if ('([{'.includes(masked[i])) depth++
      else if (')]}'.includes(masked[i])) depth--
      else if (depth === 0 && masked.startsWith(':=', i)) {
        bodyStart = i + 2
        break
      }
      if (
        depth === 0 &&
        !/[\p{L}\p{N}_'.]/u.test(masked[i - 1] || '') &&
        /^(?:let|have|fun|match|do|by)\b/.test(masked.slice(i))
      )
        throw new Error(`Unsupported theorem statement syntax for ${match[2]}.`)
      if (depth < 0) break
      if (
        i > match.index &&
        masked[i - 1] === '\n' &&
        /^\s*(?:theorem|lemma|end|namespace)\b/.test(
          masked.slice(i).split('\n')[0],
        )
      )
        break
    }
    if (bodyStart < 0)
      throw new Error(`Cannot locate the proof body of ${match[2]}.`)
    const indent = /^[ \t]*/.exec(match[0])[0].length
    let end = source.length,
      cursor = masked.indexOf('\n', bodyStart)
    while (cursor >= 0 && cursor + 1 < masked.length) {
      const lineStart = cursor + 1,
        next = masked.indexOf('\n', lineStart)
      const line = masked.slice(lineStart, next < 0 ? masked.length : next)
      if (line.trim() && /^[ \t]*/.exec(line)[0].length <= indent) {
        if (/^\s*(?:where|termination_by|decreasing_by)\b/.test(line))
          throw new Error(`Unsupported proof boundary for ${match[2]}.`)
        end = lineStart
        break
      }
      cursor = next
    }
    // Include preceding one-line attributes and a directly attached doc comment.
    while (start > 0) {
      const previousEnd = start - 1,
        previousStart = masked.lastIndexOf('\n', previousEnd - 1) + 1
      if (!/^\s*@\[[^\n]*\]\s*$/.test(masked.slice(previousStart, previousEnd)))
        break
      start = previousStart
    }
    const prefix = source.slice(0, start)
    const docEnd = prefix.lastIndexOf('-/') + 2
    if (docEnd >= 2 && !prefix.slice(docEnd).trim()) {
      const docStart = prefix.lastIndexOf('/--', docEnd)
      if (docStart >= 0 && !source.slice(docStart, docEnd).includes('/-', 3))
        start = docStart
    }
    while (end > bodyStart && /\s/.test(comments[end - 1])) end--
    if (
      !comments.slice(bodyStart, end).trim() ||
      /\b(?:where|termination_by|decreasing_by)\b/.test(
        masked.slice(bodyStart, end),
      )
    )
      throw new Error(`Unsupported proof boundary for ${match[2]}.`)
    const scopes = []
    for (const line of masked.slice(0, match.index).split('\n')) {
      const scope =
        /^\s*(namespace|section)\b\s*([\p{L}_][\p{L}\p{N}_'.]*)?/u.exec(line)
      if (scope) scopes.push(scope[1] === 'namespace' ? scope[2] || '' : '')
      else if (/^\s*end\b/.test(line)) scopes.pop()
    }
    const local = match[2],
      name = local.startsWith('_root_.')
        ? local.slice(7)
        : [...scopes.filter(Boolean), local].join('.')
    if (
      result.some((item) => item.name === name) ||
      (result.at(-1)?.end || 0) > start
    )
      throw new Error(
        'Overlapping or duplicate theorem declarations cannot be measured automatically.',
      )
    result.push({
      name,
      start,
      end,
      bodyStart,
      tokens: proofTokenCount(source.slice(bodyStart, end)),
    })
  }
  return result
}

const wrapper =
  String.raw`
open Lean Elab Command in
local elab "#lemex_web_measure " marker:str " target " declName:str " end " expectedEnd:num " in " cmd:command : command => do
  let some tail := cmd.raw.getTailPos? | throwError "LEMEX_UNSUPPORTED: Cannot locate declaration end"
  unless tail.byteIdx == expectedEnd.getNat do
    throwError "LEMEX_UNSUPPORTED: Expected exactly one complete theorem declaration"
  let targetName := declName.getString.toName
  if (← getEnv).contains targetName then
    throwError "LEMEX_UNSUPPORTED: Target already exists"
  let start ← IO.getNumHeartbeats
  elabCommand (← ` +
  '`' +
  String.raw`(command| set_option Elab.async false in set_option maxHeartbeats 0 in $cmd))
  let finish ← IO.getNumHeartbeats
  unless (← getEnv).contains targetName do
    throwError "LEMEX_UNSUPPORTED: Declaration did not introduce the expected theorem"
  let axioms ← Lean.collectAxioms targetName
  if axioms.contains ` +
  '``' +
  String.raw`sorryAx then
    throwError "LEMEX_UNSUPPORTED: The theorem depends on sorryAx"
  let payload := Json.mkObj [("marker", toJson marker.getString), ("raw", toJson (finish - start))]
  logInfo m!"{payload.compress}"
`

export function instrumentOptimizationSource(source, nonce = randomUUID()) {
  const theorems = optimizationTheorems(source)
  const masked = scan(source, true)
  let headerEnd = 0
  for (const match of masked.matchAll(
    /^[ \t]*(?:public[ \t]+)?import[ \t]+[^\n]+(?:\n|$)/gm,
  )) {
    if (masked.slice(headerEnd, match.index).trim())
      throw new Error(
        'Imports must precede all declarations for automatic measurement.',
      )
    headerEnd = match.index + match[0].length
  }
  let text =
      'import Lean\n' + source.slice(0, headerEnd) + '\n' + wrapper + '\n',
    cursor = headerEnd
  const entries = []
  for (const theorem of theorems) {
    text += source.slice(cursor, theorem.start)
    const marker = `${nonce}/${entries.length}`
    const declaration = source.slice(theorem.start, theorem.end)
    let expectedEnd = 0,
      prefix
    for (;;) {
      prefix = `#lemex_web_measure ${JSON.stringify(marker)} target ${JSON.stringify(theorem.name)} end ${expectedEnd} in\n`
      const actual = Buffer.byteLength(text + prefix + declaration, 'utf8')
      if (actual === expectedEnd) break
      expectedEnd = actual
    }
    text += prefix + declaration
    entries.push({ name: theorem.name, tokens: theorem.tokens, marker })
    cursor = theorem.end
  }
  return { content: text + source.slice(cursor), theorems: entries }
}

// Local imports are rebuilt into /tmp before selected modules are measured.
// No project cache, model home, or source file is writable by this process.
const measurementScript = String.raw`
import json, os, pathlib, subprocess, sys, tempfile
entries=json.loads(sys.argv[1]); workspace=pathlib.Path('/workspace')
lean=str(pathlib.Path(os.environ['LEAN_SYSROOT'])/'bin/lean')
result={'compiled':True,'available':True,'files':[],'reason':None}
source_roots=[pathlib.Path(p) for p in os.environ.get('LEAN_SRC_PATH','').split(':') if p and pathlib.Path(p).is_relative_to(workspace) and not pathlib.Path(p).is_relative_to(workspace/'.lake')]
source_roots=sorted(set(source_roots+[workspace]),key=lambda p:len(p.parts),reverse=True)
local_paths=[pathlib.Path(p) for p in os.environ.get('LEAN_PATH','').split(':') if p and pathlib.Path(p).is_relative_to(workspace) and not pathlib.Path(p).is_relative_to(workspace/'.lake/packages')]
trusted_paths=[p for p in os.environ.get('LEAN_PATH','').split(':') if p and pathlib.Path(p) not in local_paths]
sources={}; selected={entry['path']:entry for entry in entries}
for source_root in source_roots:
  for directory, children, files in os.walk(source_root,followlinks=False):
    children[:]=[c for c in children if not c.startswith('.') and not pathlib.Path(directory,c).is_symlink()]
    for name in files:
      file=pathlib.Path(directory,name)
      if name.endswith('.lean') and name!='lakefile.lean' and not file.is_symlink():
        sources.setdefault('.'.join(file.relative_to(source_root).with_suffix('').parts),file)
with tempfile.TemporaryDirectory(prefix='lemex-metrics-') as temporary:
  temp=pathlib.Path(temporary); env=dict(os.environ); env['LEAN_PATH']=str(temp/'lib')+':'+':'.join(trusted_paths)
  # --deps only resolves import paths; placeholders let it inspect unbuilt local
  # modules without loading an old project .olean or executing their commands.
  inspection_env=dict(env); inspection_env['LEAN_PATH']=str(temp/'imports')+':'+':'.join(trusted_paths)
  for module in sources:
    stub=temp/'imports'/pathlib.Path(*module.split('.')).with_suffix('.olean')
    stub.parent.mkdir(parents=True,exist_ok=True); stub.touch()
  compiled=set(); visiting=set()
  def diagnostics(proc):
    items=[]
    for line in proc.stdout.splitlines():
      try: items.append(json.loads(line))
      except json.JSONDecodeError: pass
    return items
  def compile_module(module,file):
    if module in compiled: return True
    if module in visiting: raise ValueError('Circular local imports cannot be measured.')
    if any(not part.replace('_','a').replace("'",'a').isalnum() for part in module.split('.')): raise ValueError('Unsupported local module name: '+module)
    visiting.add(module)
    deps=subprocess.run([lean,'--deps',str(file)],text=True,capture_output=True,env=inspection_env)
    if deps.returncode: raise ValueError('Cannot inspect local imports: '+deps.stdout[-3000:]+deps.stderr[-3000:])
    for line in deps.stdout.splitlines():
      imported=pathlib.Path(line)
      for prefix in [temp/'imports']+local_paths:
        if imported.is_relative_to(prefix):
          dependency='.'.join(imported.relative_to(prefix).with_suffix('').parts)
          source=sources.get(dependency)
          if not source: raise ValueError('Cannot replay local imported source: '+dependency)
          if not compile_module(dependency,source): return False
          break
    relative=str(file.relative_to(workspace)); entry=selected.get(relative)
    source_root=next(prefix for prefix in source_roots if file.is_relative_to(prefix))
    input_file=file; compile_root=source_root
    if entry:
      if file.read_text(encoding='utf-8')!=entry['source']: raise ValueError('Selected source changed before measurement.')
      compile_root=temp/'source'/str(source_roots.index(source_root))
      input_file=compile_root/file.relative_to(source_root)
      input_file.parent.mkdir(parents=True,exist_ok=True); input_file.write_text(entry['instrumented'],encoding='utf-8')
    output=temp/'lib'/pathlib.Path(*module.split('.')).with_suffix('.olean'); output.parent.mkdir(parents=True,exist_ok=True)
    args=[lean,'--root='+str(compile_root),'--json','-Dwarn.sorry=true','-o',str(output),str(input_file)]
    proc=subprocess.run(args,text=True,capture_output=True,env=env)
    items=diagnostics(proc)
    if proc.returncode:
      # An unsupported wrapper must not turn a valid proof into a failure.
      if entry:
        plain=subprocess.run([lean,'--root='+str(source_root),'--json',str(file)],text=True,capture_output=True,env=env)
        result['compiled']=plain.returncode==0
      else: result['compiled']=False
      result['available']=False
      errors=[str(item.get('data',item.get('message',''))) for item in items if item.get('severity')=='error']
      result['reason']=('Unsupported declaration measurement: ' if result['compiled'] else 'Lean compilation failed: ')+('\n'.join(errors) or proc.stderr or proc.stdout)[-5000:]
      return False
    if entry:
      by_marker={}
      for item in items:
        if item.get('severity')!='information': continue
        try: payload=json.loads(str(item.get('data',item.get('message',''))))
        except (json.JSONDecodeError,TypeError): continue
        marker=payload.get('marker') if isinstance(payload,dict) else None
        if marker in [theorem['marker'] for theorem in entry['theorems']]:
          raw=payload.get('raw')
          if marker in by_marker or type(raw)!=int or raw<0 or raw>9007199254740991: raise ValueError('Invalid or duplicate heartbeat measurement marker.')
          by_marker[marker]=raw
      theorems=[]
      for theorem in entry['theorems']:
        raw=by_marker.get(theorem['marker'])
        if raw is None: raise ValueError('The compiler did not emit every heartbeat measurement.')
        theorems.append({'name':theorem['name'],'tokens':theorem['tokens'],'heartbeatsRaw':raw,'heartbeats':raw/1000})
      result['files'].append({'path':relative,'theorems':theorems})
    visiting.remove(module); compiled.add(module); return True
  try:
    for entry in entries:
      file=workspace/entry['path']
      module=next(('.'.join(file.relative_to(prefix).with_suffix('').parts) for prefix in source_roots if file.is_relative_to(prefix)),None)
      if not module or not compile_module(module,file): result['available']=False; break
  except Exception as error:
    result['available']=False; result['compiled']=None; result['reason']=str(error)
print(json.dumps(result))
`

function unavailable(reason, compiled = null, files = []) {
  return {
    compiled,
    available: false,
    files,
    totalTokens: null,
    totalHeartbeatsRaw: null,
    proofTokens: null,
    heartbeats: null,
    reason,
    method: optimizationMethod,
  }
}

/** Measure immutable baseline/candidate roots separately under their exact toolchain. */
export async function measureOptimization(runtime, root, paths, options = {}) {
  if (!Array.isArray(paths) || !paths.length)
    return unavailable(
      'Select a local Lean file containing named theorems to measure.',
    )
  const entries = []
  try {
    const actualRoot = await fs.realpath(root)
    for (const filename of [...new Set(paths)]) {
      if (
        typeof filename !== 'string' ||
        !filename.endsWith('.lean') ||
        filename.includes('\\') ||
        filename
          .split('/')
          .some(
            (part) =>
              !part || part === '.' || part === '..' || part.startsWith('.'),
          ) ||
        path.isAbsolute(filename) ||
        filename === 'lakefile.lean'
      )
        return unavailable(
          'Only local project Lean source files can be measured.',
        )
      let location = actualRoot
      for (const segment of filename.split('/')) {
        location = path.join(location, segment)
        if ((await fs.lstat(location)).isSymbolicLink())
          return unavailable('Symlinked source files cannot be measured.')
      }
      const source = await fs.readFile(location, 'utf8')
      if (Buffer.byteLength(source) > 1024 * 1024)
        return unavailable(
          'The selected source exceeds the automatic measurement size limit.',
        )
      const instrumented = instrumentOptimizationSource(source)
      if (!instrumented.theorems.length)
        return unavailable(
          `No supported named theorems were found in ${filename}.`,
        )
      entries.push({
        path: filename,
        source,
        instrumented: instrumented.content,
        theorems: instrumented.theorems,
      })
    }
  } catch (error) {
    return unavailable(error.message)
  }
  const workerOptions = {
    signal: options.signal,
    onOutput: options.onOutput,
    network: 'none',
    readOnlyWorkspace: true,
    freshHome: true,
    readOnlyHome: true,
    timeoutMs: 180_000,
  }
  try {
    const environment = await runtime.run(
      root,
      [
        'lake',
        'env',
        'python3',
        '-I',
        '-c',
        'import os,json; print(json.dumps({k:os.environ.get(k,"") for k in ["LEAN_PATH","LEAN_SRC_PATH","LEAN_SYSROOT"]}))',
      ],
      workerOptions,
    )
    if (environment.code !== 0 || environment.truncated)
      return unavailable(
        'Could not resolve the pinned Lake environment for measurement.',
      )
    const env = JSON.parse(environment.stdout.trim().split('\n').at(-1))
    if (
      !/^\/opt\/lean-toolchains\/[^/]+$/.test(env.LEAN_SYSROOT) ||
      ['LEAN_PATH', 'LEAN_SRC_PATH'].some(
        (key) =>
          typeof env[key] !== 'string' ||
          env[key]
            .split(':')
            .some(
              (value) =>
                value &&
                (path.posix.normalize(value) !== value ||
                  !/^\/workspace(?:\/|$)|^\/opt\/lean-toolchains\//.test(
                    value,
                  )),
            ),
      )
    )
      return unavailable(
        'The Lake environment is not safe for isolated measurement.',
      )
    const output = await runtime.run(
      root,
      ['python3', '-I', '-c', measurementScript, JSON.stringify(entries)],
      { ...workerOptions, env },
    )
    if (
      output.code !== 0 ||
      output.truncated ||
      output.timedOut ||
      options.signal?.aborted
    )
      return unavailable('The isolated Lean measurement did not complete.')
    const result = JSON.parse(output.stdout.trim().split('\n').at(-1))
    if (
      ![true, false, null].includes(result.compiled) ||
      typeof result.available !== 'boolean' ||
      !Array.isArray(result.files)
    )
      return unavailable('The isolated worker returned an invalid measurement.')
    if (!result.available)
      return unavailable(
        result.reason || 'Metrics are unavailable for this declaration syntax.',
        result.compiled,
        result.files,
      )
    if (result.compiled !== true || result.files.length !== entries.length)
      return unavailable('The compiler did not measure every selected file.')
    let totalTokens = 0,
      totalHeartbeatsRaw = 0
    for (const entry of entries) {
      const file = result.files.find((item) => item.path === entry.path)
      if (
        !file ||
        !Array.isArray(file.theorems) ||
        file.theorems.length !== entry.theorems.length
      )
        return unavailable(
          'The compiler did not measure every selected theorem.',
        )
      for (const theorem of entry.theorems) {
        const metric = file.theorems.find((item) => item.name === theorem.name)
        if (
          !metric ||
          metric.tokens !== theorem.tokens ||
          !Number.isSafeInteger(metric.heartbeatsRaw) ||
          metric.heartbeatsRaw < 0 ||
          metric.heartbeats !== metric.heartbeatsRaw / 1000
        )
          return unavailable('The compiler returned invalid theorem metrics.')
        totalTokens += metric.tokens
        totalHeartbeatsRaw += metric.heartbeatsRaw
      }
    }
    if (
      !Number.isSafeInteger(totalHeartbeatsRaw) ||
      !Number.isSafeInteger(totalTokens)
    )
      return unavailable('Metric totals exceed the supported numeric range.')
    return {
      compiled: true,
      available: true,
      files: result.files,
      totalTokens,
      totalHeartbeatsRaw,
      proofTokens: totalTokens,
      heartbeats: totalHeartbeatsRaw / 1000,
      reason: null,
      method: optimizationMethod,
    }
  } catch (error) {
    return unavailable(
      options.signal?.aborted
        ? 'Measurement was cancelled.'
        : `Measurement unavailable: ${error.message}`,
    )
  }
}
