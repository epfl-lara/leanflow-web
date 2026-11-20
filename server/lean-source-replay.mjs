export const standardLeanAxioms = Object.freeze([
  'propext',
  'Classical.choice',
  'Quot.sound',
])

// Compile selected modules and their local imports from source into a disposable
// directory. Only modules replayed by the pinned kernel checker enter selected.
const replayScript = String.raw`
import json, os, pathlib, subprocess, sys, tempfile
request=json.load(sys.stdin)
paths=request['paths'] if isinstance(request,dict) else request
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
        dependencies=None
        if isinstance(request,dict):
            # A fresh checkout may have no local .olean files. Ask Lean's
            # header parser for names before resolving any compiled artifacts.
            header=subprocess.run([lean,'--deps-json',str(file)],text=True,capture_output=True)
            if header.returncode==0:
                try:
                    item,=json.loads(header.stdout)['imports']
                    if not item.get('errors'):
                        dependencies=[dep['module'] for dep in item.get('result',item)['imports']]
                except (ValueError,KeyError,TypeError,AttributeError): pass
        if dependencies is None:
            # The existing candidate audit runs after lake build and keeps its
            # original --deps behavior. It also works as a compatibility path
            # when an older compiler cannot provide a parsed import header.
            deps=subprocess.run([lean,'--deps',str(file)],text=True,capture_output=True)
            if deps.returncode:
                result['errors'].append('Import inspection failed: '+deps.stdout[-5000:]+deps.stderr[-5000:]); return False
            dependencies=[]
            for line in deps.stdout.splitlines():
                imported=pathlib.Path(line)
                for prefix in local_paths:
                    if imported.is_relative_to(prefix):
                        dependency='.'.join(imported.relative_to(prefix).with_suffix('').parts)
                        if dependency not in sources:
                            result['errors'].append('Cannot replay local import from source: '+dependency); return False
                        dependencies.append(dependency)
                        break
        for dependency in dependencies:
            if dependency in sources and not compile_module(dependency,sources[dependency]): return False
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
    selected={}
    for relative in paths:
        file=workspace/relative
        module=next(('.'.join(file.relative_to(prefix).with_suffix('').parts) for prefix in source_roots if file.is_relative_to(prefix)),None)
        if not module or (isinstance(request,dict) and sources.get(module) != file) or not compile_module(module,file):
            result['compiled']=False; result['complete']=False
        else: selected[module]=relative
`

export async function pinnedAuditEnvironment(runtime, root, options) {
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
    return { env: auditEnv }
  } catch {
    return { errors: [environment.stdout, environment.stderr] }
  }
}

export function replayLeanSources(
  runtime,
  root,
  env,
  input,
  inspectScript,
  options,
) {
  return runtime.run(
    root,
    ['python3', '-I', '-c', replayScript + inspectScript],
    {
      ...options,
      // The compiler enumerates declarations from rebuilt modules. A project
      // file list can exceed the OS limit for one command argument.
      input: JSON.stringify(input),
      env,
      readOnlyWorkspace: true,
      freshHome: true,
      readOnlyHome: true,
      network: 'none',
      timeoutMs: 180_000,
    },
  )
}
