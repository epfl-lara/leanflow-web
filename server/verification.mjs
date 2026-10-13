import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

// These checks are independent of the agent's own statements and diagnostics.
// Lean checks dependencies of every named declaration in the changed modules.
export function maskLean(source, preserveStrings = false) {
  let output = '',
    depth = 0,
    quoted = false
  for (let i = 0; i < source.length; i++) {
    const a = source[i],
      b = source[i + 1]
    if (depth) {
      if (a === '/' && b === '-') {
        depth++
        output += '  '
        i++
      } else if (a === '-' && b === '/') {
        depth--
        output += '  '
        i++
      } else output += a === '\n' ? '\n' : ' '
    } else if (quoted) {
      if (a === '\\') {
        output += preserveStrings ? source.slice(i, i + 2) : '  '
        i++
      } else {
        if (a === '"') quoted = false
        output += preserveStrings ? a : a === '\n' ? '\n' : ' '
      }
    } else if (a === '"') {
      quoted = true
      output += preserveStrings ? a : ' '
    } else if (a === '/' && b === '-') {
      depth++
      output += '  '
      i++
    } else if (a === '-' && b === '-') {
      while (i < source.length && source[i] !== '\n') {
        output += ' '
        i++
      }
      if (i < source.length) output += '\n'
    } else output += a
  }
  return output
}

export function declarationNames(source) {
  const masked = maskLean(source),
    scopes = [],
    result = []
  for (const line of masked.split('\n')) {
    const scope = /^\s*(namespace|section)\b\s*([^\s]*)/.exec(line)
    if (scope) scopes.push(scope[1] === 'namespace' ? scope[2] : '')
    if (/^\s*end\b/.test(line)) scopes.pop()
    const match =
      /^\s*(?:(?:private|protected|noncomputable|unsafe|partial)\s+)*(?:theorem|lemma|def|opaque|abbrev)\s+([\p{L}_][\p{L}\p{N}_'.]*)/u.exec(
        line,
      )
    if (match) result.push([...scopes.filter(Boolean), match[1]].join('.'))
  }
  return result
}

export function proofRisks(changes, mode) {
  const problems = []
  for (const change of changes) {
    if (
      !change.path.endsWith('.lean') ||
      /(?:^|\/)(?:lakefile\.lean|\.git|\.lake|lean-toolchain|lake-manifest\.json)(?:\/|$)/.test(
        change.path,
      )
    ) {
      problems.push(
        `Changes to ${change.path} require a separate project configuration edit.`,
      )
      continue
    }
    if (change.after === null) {
      problems.push(`Deleting ${change.path} requires a separate manual edit.`)
      continue
    }
    const code = maskLean(change.after || '')
    if (
      /\b(?:run_tac|run_cmd|initialize|elab|macro_rules)\b|#(?:eval|reduce)|\bIO\s*\./.test(
        code,
      )
    )
      problems.push(
        `${change.path} contains executable metaprogramming. Review that source manually before integrating it.`,
      )
    if (
      /\b(?:axiom|unsafe|implemented_by|extern)\b/.test(code) ||
      /debug\.skipKernelTC|warn\.sorry\s+false/.test(code)
    )
      problems.push(
        `${change.path} changes the proof trust settings or declares an axiom.`,
      )
    if (
      (mode === 'repair' || mode === 'prove') &&
      /\b(?:sorry|admit)\b/.test(code)
    )
      problems.push(`${change.path} still contains an unfinished proof.`)
    if ((mode === 'repair' || mode === 'prove') && change.before) {
      const before = theoremHeaders(change.before),
        after = theoremHeaders(change.after)
      for (const [name, header] of before)
        if (after.get(name) !== header)
          problems.push(
            `${change.path} changes the statement of ${name}. Repair/prove mode preserves existing theorem statements.`,
          )
      const context = (source) =>
        maskLean(source)
          .split('\n')
          .filter((line) =>
            /^\s*(?:namespace|section|variable|variables|include|omit|open|end)\b/.test(
              line,
            ),
          )
          .map((line) => line.trim())
          .join('\n')
      if (context(change.before) !== context(change.after))
        problems.push(
          `${change.path} changes the surrounding namespace, variables, or assumptions.`,
        )
      if (hiddenProofCommands(change.after))
        problems.push(
          `${change.path} includes a command inside a proof span. Review command changes manually.`,
        )
      if (proofSkeleton(change.before) !== proofSkeleton(change.after))
        problems.push(
          `${change.path} changes code outside existing theorem proof bodies. Use formalization mode for new declarations or edit the project manually.`,
        )
    }
  }
  return problems
}

function proofSpans(source) {
  const masked = maskLean(source),
    spans = []
  const pattern =
    /^[ \t]*(?:@\[[^\n]*?\][ \t]*)*(?:(?:private|protected|noncomputable)\s+)*(?:theorem|lemma)\b/gm
  for (const match of masked.matchAll(pattern)) {
    let depth = 0,
      start = -1
    for (let i = match.index + match[0].length; i < masked.length; i++) {
      if ('([{'.includes(masked[i])) depth++
      else if (')]}'.includes(masked[i])) depth--
      else if (depth === 0 && masked.slice(i, i + 2) === ':=') {
        start = i + 2
        break
      }
    }
    if (start === -1) continue
    const indent = /^[ \t]*/.exec(match[0])[0].length
    let end = source.length
    for (
      let at = masked.indexOf('\n', start) + 1;
      at > 0 && at < masked.length;
    ) {
      const next = masked.indexOf('\n', at),
        line = masked.slice(at, next === -1 ? masked.length : next)
      if (line.trim() && /^[ \t]*/.exec(line)[0].length <= indent) {
        end = at
        break
      }
      if (next === -1) break
      at = next + 1
    }
    spans.push({ start, end })
  }
  return spans
}

function hiddenProofCommands(source) {
  const masked = maskLean(source)
  return proofSpans(source).some(({ start, end }) =>
    /(?:^|\n)[ \t]*(?:@\[|#|(?:(?:private|protected|noncomputable|local|scoped)\s+)*(?:theorem|lemma|def|opaque|abbrev|example|axiom|constant|structure|inductive|class|instance|attribute|notation|infixl|infixr|infix|prefix|postfix|macro|macro_rules|syntax|elab|initialize|set_option|namespace|section|variable|variables|include|omit|open|export|end)\b)/.test(
      masked.slice(start, end),
    ),
  )
}

export function proofSkeleton(source) {
  const spans = proofSpans(source)
  let outside = '',
    previous = 0
  for (const { start, end } of spans) {
    if (start < previous) continue
    outside += source.slice(previous, start) + ' __PROOF__\n'
    previous = end
  }
  outside += source.slice(previous)
  const stripped = maskLean(outside, true)
  // String literals remain exact; formatting and comments elsewhere are ignored.
  return (stripped.match(/"(?:\\.|[^"\\])*"|[^\s]/g) || []).join('')
}

export function theoremHeaders(source) {
  const masked = maskLean(source),
    result = new Map()
  const scopes = [],
    commands = [
      ...masked.matchAll(/^\s*(namespace|section|end)\b\s*([^\s]*)/gm),
    ]
  let nextCommand = 0
  const regex = /\b(?:theorem|lemma)\s+([\p{L}_][\p{L}\p{N}_'.]*)/gu
  for (const match of masked.matchAll(regex)) {
    while (
      nextCommand < commands.length &&
      commands[nextCommand].index < match.index
    ) {
      const command = commands[nextCommand++]
      if (command[1] === 'end') scopes.pop()
      else scopes.push(command[1] === 'namespace' ? command[2] : '')
    }
    let depth = 0,
      end = -1
    for (let i = match.index + match[0].length; i < masked.length; i++) {
      if ('([{'.includes(masked[i])) depth++
      else if (')]}'.includes(masked[i])) depth--
      else if (depth === 0 && masked.slice(i, i + 2) === ':=') {
        end = i
        break
      }
    }
    const name = match[1].startsWith('_root_.')
      ? match[1].slice(7)
      : [...scopes.filter(Boolean), match[1]].join('.')
    if (end !== -1)
      result.set(
        name,
        source.slice(match.index, end).replace(/\s+/g, ' ').trim(),
      )
  }
  return result
}

const auditScript = String.raw`
import json, os, pathlib, subprocess, sys, tempfile
entries=json.loads(sys.argv[1])
result={'compiled':True,'complete':True,'kernelChecked':True,'files':[],'errors':[],'warnings':[],'axioms':[]}
workspace=pathlib.Path('/workspace')
sysroot=pathlib.Path(os.environ['LEAN_SYSROOT'])
lean=str(sysroot/'bin/lean'); checker=str(sysroot/'bin/leanchecker')
source_roots=[pathlib.Path(p) for p in os.environ.get('LEAN_SRC_PATH','').split(':') if p and pathlib.Path(p).is_relative_to(workspace) and not pathlib.Path(p).is_relative_to(workspace/'.lake')]
source_roots=sorted(set(source_roots+[workspace]),key=lambda p:len(p.parts),reverse=True)
local_paths=[pathlib.Path(p) for p in os.environ.get('LEAN_PATH','').split(':') if p and pathlib.Path(p).is_relative_to(workspace) and not pathlib.Path(p).is_relative_to(workspace/'.lake/packages')]
trusted_paths=[p for p in os.environ.get('LEAN_PATH','').split(':') if p and pathlib.Path(p) not in local_paths]
sources={}
for source_root in source_roots:
    for directory, children, files in os.walk(source_root,followlinks=False):
        children[:]=[c for c in children if not c.startswith('.') and not pathlib.Path(directory,c).is_symlink()]
        for name in files:
            file=pathlib.Path(directory,name)
            if not name.endswith('.lean') or name=='lakefile.lean' or file.is_symlink(): continue
            module='.'.join(file.relative_to(source_root).with_suffix('').parts)
            sources.setdefault(module,file)
with tempfile.TemporaryDirectory(prefix='lean-web-audit-') as temp:
    env=dict(os.environ); env['LEAN_PATH']=temp+':'+':'.join(trusted_paths)
    compiled=set(); visiting=set(); imports=[]
    def compile_module(module,file):
        if module in compiled: return True
        if module in visiting:
            result['errors'].append('Circular local module imports: '+module); return False
        if any(not part.replace('_','a').isalnum() for part in module.split('.')):
            result['errors'].append('Module name cannot be audited automatically: '+module); return False
        visiting.add(module)
        # --deps reads import headers; it does not execute the source body.
        deps=subprocess.run([lean,'--deps',str(file)],text=True,capture_output=True)
        if deps.returncode:
            result['errors'].append('Import inspection failed: '+deps.stdout[-5000:]+deps.stderr[-5000:]); return False
        for line in deps.stdout.splitlines():
            imported=pathlib.Path(line)
            for prefix in local_paths:
                if imported.is_relative_to(prefix):
                    dependency='.'.join(imported.relative_to(prefix).with_suffix('').parts)
                    source=sources.get(dependency)
                    if not source:
                        result['errors'].append('Cannot replay local import from source: '+dependency); return False
                    if not compile_module(dependency,source): return False
                    break
        output=pathlib.Path(temp)/pathlib.Path(*module.split('.')).with_suffix('.olean')
        output.parent.mkdir(parents=True,exist_ok=True)
        source_root=next(prefix for prefix in source_roots if file.is_relative_to(prefix))
        proc=subprocess.run([lean,'--root='+str(source_root),'--json','-Dwarn.sorry=true','-o',str(output),str(file)],text=True,capture_output=True,env=env)
        diagnostics=[]
        for line in proc.stdout.splitlines():
            try: item=json.loads(line)
            except json.JSONDecodeError: continue
            diagnostics.append(item)
            message=item.get('data',item.get('message',''))
            if item.get('severity')=='error': result['errors'].append(message)
            if item.get('severity')=='warning': result['warnings'].append(message)
            if 'declaration uses' in str(message) and 'sorry' in str(message): result['complete']=False
        result['files'].append({'path':str(file.relative_to(workspace)),'module':module,'code':proc.returncode,'diagnostics':diagnostics})
        if proc.returncode:
            result['errors'].append(proc.stderr or proc.stdout[-5000:]); return False
        kernel=subprocess.run([checker,'-v',module],text=True,capture_output=True,env=env)
        if kernel.returncode:
            result['kernelChecked']=False; result['errors'].append('Kernel replay failed: '+kernel.stdout[-5000:]+kernel.stderr[-5000:]); return False
        visiting.remove(module); compiled.add(module); imports.append(module); return True
    for entry in entries:
        file=workspace/entry['path']
        module=next(('.'.join(file.relative_to(prefix).with_suffix('').parts) for prefix in source_roots if file.is_relative_to(prefix)),None)
        if not module or not compile_module(module,file): result['compiled']=False; result['complete']=False
    if result['compiled'] and imports:
        script=pathlib.Path(temp)/'WebProofAudit.lean'
        script.write_text('import Lean\n'+'\n'.join('import '+module for module in imports)+'\n'+
            'open Lean Elab Command in\nrun_cmd do\n'+
            '  let modules : Array String := #'+json.dumps(imports)+'\n'+
            '  let env \u2190 getEnv\n'+
            '  for (name, _) in env.constants.toList do\n'+
            '    if let some idx := env.getModuleIdxFor? name then\n'+
            '      if modules.contains env.header.moduleNames[idx.toNat]!.toString then\n'+
            '        let axs \u2190 collectAxioms name\n'+
            '        logInfo m!"{name} depends on axioms: {axs}"\n')
        proc=subprocess.run([lean,'--json',str(script)],text=True,capture_output=True,env=env)
        if proc.returncode:
            result['complete']=False; result['errors'].append('Axiom inspection failed: '+proc.stdout[-5000:]+proc.stderr)
        for line in proc.stdout.splitlines():
            try: item=json.loads(line)
            except json.JSONDecodeError: continue
            text=str(item.get('data',item.get('message','')))
            if 'depends on axioms' in text or 'does not depend on any axioms' in text:
                result['axioms'].append(text)
                if 'sorryAx' in text: result['complete']=False
                if 'depends on axioms' in text:
                    allowed={'propext','Classical.choice','Quot.sound'}
                    actual=text.partition('[')[2].partition(']')[0]
                    unexpected=[name.strip() for name in actual.split(',') if name.strip() and name.strip() not in allowed]
                    if unexpected: result['complete']=False; result['errors'].append('Nonstandard axioms: '+', '.join(unexpected))
            elif item.get('severity')=='error': result['complete']=False; result['errors'].append(text)
    if result['warnings']: result['reason']='Review compiler warnings before accepting the result.'
    if not result['complete']: result['reason']='The candidate is incomplete or did not pass the proof integrity checks.'
print(json.dumps(result))
`

async function sourceFingerprint(root) {
  const files = []
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.lake', '.git'].includes(entry.name)) continue
      const filename = path.join(directory, entry.name),
        name = path.posix.join(relative, entry.name)
      if (entry.isSymbolicLink())
        files.push([name, 'link', await fs.readlink(filename)])
      else if (entry.isDirectory()) await walk(filename, name)
      else if (entry.isFile())
        files.push([
          name,
          createHash('sha256')
            .update(await fs.readFile(filename))
            .digest('hex'),
        ])
    }
  }
  await walk(root)
  return JSON.stringify(files.sort((a, b) => a[0].localeCompare(b[0])))
}

export async function verifyCandidate(
  runtime,
  root,
  changes,
  mode,
  onOutput,
  options = {},
) {
  const risks = proofRisks(changes, mode)
  if (risks.length)
    return {
      compiled: false,
      complete: false,
      files: [],
      errors: risks,
      reason: 'Candidate requires manual review.',
    }
  const entries = changes
    .filter((change) => change.after !== null && change.path.endsWith('.lean'))
    .map((change) => ({
      path: change.path,
      names: declarationNames(change.after),
    }))
  if (!entries.length)
    return {
      compiled: true,
      complete: true,
      files: [],
      axioms: [],
      reason: 'No Lean file changes to check.',
    }
  // Resolve the trusted baseline Lake environment before compiling model code.
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
    { ...options, freshHome: true, network: 'none', timeoutMs: 180_000 },
  )
  let auditEnv
  try {
    if (environment.code !== 0)
      throw new Error('Cannot resolve Lake environment')
    auditEnv = JSON.parse(environment.stdout.trim().split('\n').at(-1))
    if (
      !/^\/opt\/lean-toolchains\/[^/]+$/.test(auditEnv.LEAN_SYSROOT) ||
      ['LEAN_PATH', 'LEAN_SRC_PATH'].some(
        (key) =>
          typeof auditEnv[key] !== 'string' ||
          auditEnv[key]
            .split(':')
            .some(
              (value) =>
                value &&
                !value.startsWith('/workspace') &&
                !value.startsWith('/opt/lean-toolchains/'),
            ),
      )
    )
      throw new Error('Untrusted Lean environment')
  } catch {
    return {
      compiled: false,
      complete: false,
      files: [],
      errors: [environment.stdout, environment.stderr],
      reason: 'Could not resolve the pinned Lean verification environment.',
    }
  }
  const fingerprint = await sourceFingerprint(root)
  const build = await runtime.run(root, ['lake', 'build'], {
    ...options,
    network: 'none',
    timeoutMs: 600_000,
    onOutput,
  })
  if (build.code !== 0)
    return {
      compiled: false,
      complete: false,
      files: [],
      errors: [build.stdout, build.stderr].filter(Boolean),
      reason: 'The candidate project does not build.',
    }
  if ((await sourceFingerprint(root)) !== fingerprint)
    return {
      compiled: false,
      complete: false,
      files: [],
      errors: ['The candidate build changed project source or configuration.'],
      reason: 'Candidate requires manual review.',
    }
  const audit = await runtime.run(
    root,
    ['python3', '-I', '-c', auditScript, JSON.stringify(entries)],
    {
      ...options,
      env: auditEnv,
      readOnlyWorkspace: true,
      freshHome: true,
      readOnlyHome: true,
      network: 'none',
      timeoutMs: 180_000,
      onOutput,
    },
  )
  const last = audit.stdout.trim().split('\n').at(-1)
  try {
    if (audit.code !== 0) throw new Error('Audit subprocess failed.')
    const result = JSON.parse(last)
    if (
      result.kernelChecked !== true ||
      typeof result.compiled !== 'boolean' ||
      typeof result.complete !== 'boolean' ||
      !Array.isArray(result.files) ||
      !Array.isArray(result.axioms) ||
      !Array.isArray(result.errors) ||
      !Array.isArray(result.warnings) ||
      (result.complete && !result.compiled)
    )
      throw new Error('Invalid audit result.')
    return result
  } catch {
    return {
      compiled: false,
      complete: false,
      files: [],
      errors: [audit.stdout, audit.stderr],
      reason: 'The independent Lean verification did not complete.',
    }
  }
}
