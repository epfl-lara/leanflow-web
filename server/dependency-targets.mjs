import { runPinnedLake, setupInfrastructureFailure } from './pinned-lake.mjs'
import { dependencyPackageDirectory } from './project-libraries.mjs'
import { runSetupStep } from './setup-output.mjs'

// Ask the pinned Lake to evaluate its configuration. Package defaults may also
// contain demos and documentation executables that cannot run as dependencies.
const inspectLibraries = `import Lake
import Lake.Load.Workspace
open Lake
unsafe def main (imports : List String) : IO Unit := do
  let includeRoot := imports.head? == some "--include-root"
  let imports := imports.filter (· != "--include-root")
  Lean.enableInitializersExecution
  let (elanInstall?, leanInstall?, lakeInstall?) ← findInstall?
  let some lean := leanInstall? | throw (IO.userError "Lean unavailable")
  let some lake := lakeInstall? | throw (IO.userError "Lake unavailable")
  let env ← match ← (Env.compute lake lean elanInstall?).toBaseIO with
    | .ok env => pure env
    | .error error => throw (IO.userError error)
  let config : LoadConfig :=
    { lakeEnv := env, wsDir := ← IO.currentDir, updateToolchain := false }
  let some workspace ← (loadWorkspace config).run?'
    | throw (IO.userError "Could not inspect Lake dependency targets")
  let packages := workspace.packages.filter fun pkg => includeRoot || pkg.baseName != workspace.root.baseName
  let plan := packages.map fun pkg =>
    let libraries := (pkg.defaultTargets.filter fun target => (pkg.findLeanLib? target).isSome).map toString
    let modules := imports.toArray.filterMap fun name =>
      match workspace.findModule? name.toName with
      | some mod => if mod.pkg.baseName == pkg.baseName then some ("+" ++ mod.name.toString) else none
      | none => none
    (pkg.baseName.toString, libraries ++ modules)
  IO.println ("LEANFLOW_DEPENDENCY_TARGETS=" ++ (Lean.toJson plan).compress)
`

// Executable Lake configurations need native code when loaded outside Lake.
// Keep the helper in the private worker home; /tmp deliberately forbids exec.
const compileInspector = `import json, pathlib, subprocess, sys, tempfile
with tempfile.TemporaryDirectory(prefix='lake-inspect-', dir='/home/worker') as directory:
    root = pathlib.Path(directory)
    source = root / 'Main.lean'
    source.write_text(sys.stdin.read())
    generated = root / 'Main.c'
    executable = root / 'inspect'
    commands = [
        (['lean', '-c', str(generated), str(source)], root),
        (['leanc', '-o', str(executable), str(generated), '-lLake', '-rdynamic'], root),
        ([str(executable)] + json.loads(sys.argv[1]), None),
    ]
    for command, cwd in commands:
        result = subprocess.run(command, cwd=cwd)
        if result.returncode:
            sys.exit(128 - result.returncode if result.returncode < 0 else result.returncode)
`

export function parseDependencyBuildPlan(output) {
  const prefix = 'LEANFLOW_DEPENDENCY_TARGETS='
  const line = output.split('\n').findLast((line) => line.startsWith(prefix))
  let packages
  try {
    packages = JSON.parse(line?.slice(prefix.length))
  } catch {
    throw new Error('Lake did not report its dependency library targets.')
  }
  if (!Array.isArray(packages) || packages.length > 100)
    throw new Error('Invalid Lake dependency library targets.')
  const plan = Object.create(null)
  for (const entry of packages) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !dependencyPackageDirectory(entry[0]) ||
      Object.hasOwn(plan, `@${entry[0]}`) ||
      !Array.isArray(entry[1]) ||
      entry[1].length > 1000 ||
      entry[1].some(
        (name) =>
          typeof name !== 'string' ||
          name.length > 256 ||
          !name.replace(/^\+/, '').split('.').every(dependencyPackageDirectory),
      )
    )
      throw new Error('Invalid Lake dependency library targets.')
    plan[`@${entry[0]}`] = entry[1].map((name) => `@${entry[0]}/${name}`)
  }
  return plan
}

export async function dependencyBuildPlan(
  runtime,
  root,
  {
    signal,
    onOutput,
    cleanHome = true,
    requiredImports = [],
    includeRoot = false,
  } = {},
) {
  const result = await runSetupStep(
    'Inspecting dependency libraries',
    () =>
      runPinnedLake(
        runtime,
        root,
        [
          'lake',
          'env',
          'python3',
          '-c',
          compileInspector,
          JSON.stringify(
            includeRoot
              ? ['--include-root', ...requiredImports]
              : requiredImports,
          ),
        ],
        {
          signal,
          cleanHome,
          network: 'none',
          readOnlyWorkspace: true,
          writeLakeCache: true,
          timeoutMs: 180000,
          input: inspectLibraries,
        },
      ),
    { signal, onOutput },
  )
  if (result.code !== 0)
    throw Object.assign(
      new Error(
        `Could not inspect dependency libraries: ${(result.stderr || result.stdout || '').slice(-2000)}`,
      ),
      {
        setupEnvironment: true,
        infrastructure:
          setupInfrastructureFailure(result) || result.code >= 128,
      },
    )
  return parseDependencyBuildPlan(result.stdout)
}
