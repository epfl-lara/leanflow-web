import { sourceFingerprint } from './source-fingerprint.mjs'
import { PROJECT_CONFIGURATION_FILES } from '../shared/project-configuration.mjs'

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
    } else if (a === "'" && !/[\p{L}\p{N}_'.]/u.test(source[i - 1] || '')) {
      // A double quote inside a character literal must not mask later code.
      const literal =
        /^'(?:\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)|[^'\\\r\n])'/u.exec(
          source.slice(i),
        )?.[0]
      if (literal) {
        output += preserveStrings ? literal : ' '.repeat(literal.length)
        i += literal.length - 1
      } else output += a
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
      /^\s*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:private|protected|noncomputable|unsafe|partial)\s+){0,8}(?:theorem|lemma|def|opaque|abbrev)\s+([\p{L}_][\p{L}\p{N}_'.]*)/u.exec(
        line,
      )
    if (match) result.push([...scopes.filter(Boolean), match[1]].join('.'))
  }
  return result
}

export function proofRisks(changes, mode) {
  const problems = []
  for (const change of changes) {
    if (mode === 'formalize' && !change.path.endsWith('.lean')) {
      problems.push(
        `Formalize writes Lean files only. Keep ${change.path} unchanged and put extraction or scratch output outside the project.`,
      )
      continue
    }
    if (
      change.path
        .split('/')
        .some((part) =>
          ['.git', '.lake', ...PROJECT_CONFIGURATION_FILES].includes(part),
        ) ||
      (mode !== 'search' && !change.path.endsWith('.lean'))
    ) {
      problems.push(
        `Changes to ${change.path} require a separate project configuration edit.`,
      )
      continue
    }
    if (mode === 'search' && !change.path.endsWith('.lean')) continue
    if (change.after === null) {
      problems.push(`Deleting ${change.path} requires a separate manual edit.`)
      continue
    }
    if (mode === 'optimize' && !change.before) {
      problems.push(
        `${change.path}: Optimize changes existing proof bodies; use Formalize for new declarations.`,
      )
      continue
    }
    const code = maskLean(change.after || '')
    if (
      mode === 'optimize' &&
      /\b(?:native_decide|ofReduceBool|ofReduceNat)\b/.test(code)
    )
      problems.push(
        `${change.path} uses a construct excluded from proof optimization.`,
      )
    // Evaluation commands, IO and metaprogramming are ordinary Lean source.
    // Let the pinned compiler and independent proof audit check their result.
    if (
      /\b(?:axiom|unsafe|implemented_by|extern)\b/.test(code) ||
      /debug\.skipKernelTC|warn\.sorry\s+false/.test(code)
    )
      problems.push(
        `${change.path} changes the proof trust settings or declares an axiom.`,
      )
    if (
      ['proofs', 'repair', 'prove', 'optimize'].includes(mode) &&
      /\b(?:sorry|admit)\b/.test(code)
    )
      problems.push(`${change.path} still contains an unfinished proof.`)
    if (
      ['proofs', 'repair', 'prove', 'optimize'].includes(mode) &&
      change.before
    ) {
      if (
        ambiguousTheoremStatement(change.before) ||
        ambiguousTheoremStatement(change.after)
      ) {
        problems.push(
          `${change.path} contains unsupported theorem statement syntax. Review it manually before changing its proof.`,
        )
        continue
      }
      const before = theoremHeaders(change.before),
        declarations = theoremHeaderEntries(change.after),
        after = new Map(declarations.map(({ name, header }) => [name, header]))
      for (const [name, header] of before)
        if (after.get(name) !== header)
          problems.push(
            `${change.path} changes the statement of ${name}. Proof and optimization modes preserve existing theorem statements.`,
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
      const additions = new Set(
        mode === 'optimize'
          ? []
          : declarations
              .filter(({ name }) => !before.has(name))
              .map(({ start }) => start),
      )
      if (
        proofSkeleton(change.before) !== proofSkeleton(change.after, additions)
      )
        problems.push(
          mode === 'optimize'
            ? `${change.path}: LeanFlow could not confirm that only existing proof bodies changed. Keep surrounding code unchanged in Optimize mode.`
            : `${change.path}: LeanFlow could not confirm that only proofs and new theorem declarations changed. The edit may use unsupported proof syntax or change code outside proofs. Keep existing definitions and imports unchanged; use Formalize for intended changes to that code.`,
        )
    }
  }
  return problems
}

// The conservative span parser cannot distinguish a statement's top-level let
// assignment from the theorem's proof assignment. Refuse that syntax instead of
// treating part of the statement as an editable proof body.
function ambiguousTheoremStatement(source) {
  const masked = maskLean(source)
  // Attribute groups cannot consume each other's closing brackets. Bound
  // redundant modifiers so invalid multiline prefixes cannot cause quadratic
  // retries at each line. Unsupported syntax stays outside editable spans.
  const declarations =
    /^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:private|protected|noncomputable)\s+){0,8}(?:theorem|lemma|example)\b/gm
  for (const match of masked.matchAll(declarations)) {
    let depth = 0
    for (let i = match.index + match[0].length; i < masked.length; i++) {
      if ('([{'.includes(masked[i])) depth++
      else if (')]}'.includes(masked[i])) depth--
      else if (depth === 0 && masked.startsWith(':=', i)) break
      else if (
        depth === 0 &&
        !/[\p{L}\p{N}_'.]/u.test(masked[i - 1] || '') &&
        /^(?:let|have|fun|match|do|by)\b/.test(masked.slice(i))
      )
        return true
      if (depth < 0) break
    }
  }
  return false
}

function proofSpans(source) {
  const masked = maskLean(source),
    spans = []
  const pattern =
    /^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:private|protected|noncomputable)\s+){0,8}(theorem|lemma|example)\b/gm
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
    const firstToken = start + masked.slice(start).search(/\S/)
    let end = source.length
    for (
      let at = masked.indexOf('\n', start) + 1;
      at > 0 && at < masked.length;
    ) {
      const next = masked.indexOf('\n', at),
        line = masked.slice(at, next === -1 ? masked.length : next)
      if (
        at > firstToken &&
        line.trim() &&
        !/^\s*where\b/.test(line) &&
        /^[ \t]*/.exec(line)[0].length <= indent
      ) {
        end = at
        break
      }
      if (next === -1) break
      at = next + 1
    }
    spans.push({
      start,
      end,
      declarationStart: match.index,
      keywordStart: match.index + match[0].length - match[1].length,
    })
  }
  return spans
}

function hiddenProofCommands(source) {
  const masked = maskLean(source)
  return proofSpans(source).some(({ start, end }) =>
    /(?:^|[^\p{L}\p{N}_'.])(?:@\[|#(?=[\p{L}_])|(?:(?:private|protected|noncomputable|local|scoped)\s+){0,8}(?:theorem|lemma|def|opaque|abbrev|example|axiom|constant|structure|inductive|class|instance|attribute|notation|infixl|infixr|infix|prefix|postfix|macro|macro_rules|syntax|elab|initialize|set_option|namespace|section|variable|variables|include|omit|open|export|end)\b)/u.test(
      masked.slice(start, end),
    ),
  )
}

export function proofSkeleton(source, addedDeclarations = new Set()) {
  const spans = proofSpans(source)
  let outside = '',
    previous = 0
  for (const { start, end, declarationStart, keywordStart } of spans) {
    if (start < previous) continue
    outside += addedDeclarations.has(keywordStart)
      ? source.slice(previous, declarationStart)
      : source.slice(previous, start) + ' __PROOF__\n'
    previous = end
  }
  outside += source.slice(previous)
  return leanSourceKey(outside)
}

function leanSourceKey(source) {
  // Ignore comments and ordinary layout while preserving literals, identifier
  // boundaries, and adjacent operator characters. This is a conservative key;
  // the pinned compiler still parses and independently checks the candidate.
  return JSON.stringify(
    maskLean(source, true).match(
      /"(?:\\.|[^"\\])*"|'(?:\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)|[^'\\\r\n])'|«[^»]*»|[\p{L}\p{N}_][\p{L}\p{N}_'!?]*(?:\.[\p{L}\p{N}_][\p{L}\p{N}_'!?]*)*|[^\s\p{L}\p{N}_«»"'()[\]{},;]+|[^\s]/gu,
    ) || [],
  )
}

export function theoremHeaders(source) {
  return new Map(
    theoremHeaderEntries(source).map(({ name, header }) => [name, header]),
  )
}

function theoremHeaderEntries(source) {
  const masked = maskLean(source),
    result = []
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
      result.push({
        name,
        start: match.index,
        header: leanSourceKey(source.slice(match.index, end)),
      })
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
        # Enumerate rebuilt modules directly, without scanning all Mathlib constants.
        script.write_text('import Lean\n'+'\n'.join('import '+module for module in imports)+'\n'+
            'open Lean Elab Command in\nrun_cmd do\n'+
            '  let modules : Array String := #'+json.dumps(imports)+'\n'+
            '  let env \u2190 getEnv\n'+
            '  for moduleName in env.header.moduleNames, data in env.header.moduleData do\n'+
            '    if modules.contains moduleName.toString then\n'+
            '      for name in data.constNames do\n'+
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
    if result['warnings']: result['reason']='Lean verification passed with compiler warnings.'
    if not result['complete']: result['reason']='The candidate is incomplete or did not pass the proof integrity checks.'
print(json.dumps(result))
`

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
      reason:
        'Final verification stopped before Lean could check these changes.',
    }
  const entries = changes
    .filter((change) => change.after !== null && change.path.endsWith('.lean'))
    .map((change) => ({
      path: change.path,
      names: declarationNames(change.after),
    }))
  if (!entries.length && mode === 'search')
    return {
      complete: true,
      kind: 'workspace',
      files: [],
      reason:
        'Project file changes are ready to review. No Lean source changes to check.',
    }
  if (!entries.length && mode === 'formalize')
    return {
      compiled: false,
      complete: false,
      files: [],
      errors: [],
      reason:
        'No Lean formalization was written. There is no Lean output to verify.',
    }
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
  const fingerprint = await sourceFingerprint(root, { signal: options.signal })
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
  if (
    (await sourceFingerprint(root, { signal: options.signal })) !== fingerprint
  )
    return {
      compiled: false,
      complete: false,
      files: [],
      errors: ['The candidate build changed project source or configuration.'],
      reason:
        'The candidate build changed project files, so final verification stopped.',
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
