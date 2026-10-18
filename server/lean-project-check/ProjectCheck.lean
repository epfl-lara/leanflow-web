/-
Copyright (c) 2025 Lean FRO, LLC. All rights reserved.
Copyright (c) 2026 LeanFlow contributors.
Released under the Apache 2.0 license as described in the file LICENSE.
Build/export setup adapted from Lake/CLI/Main.lean in Lean 4.35.0-rc4.
-/
module

import all Lake.CLI.Main
import Lake.Build.Run
import Lake.Build.Targets
import Lake.Build.Infos
import Lake.Build.Target.Fetch
import Lake.CLI.Build
import Lake.CLI.Check
import Lake.Load.Workspace
import LeanExport.Basic
import LeanExport.Parse

/-!
Trusted adapter for the toolchain's exporter and `lake check --from-export`.

Compile this file using only the pinned toolchain's library search path. Run
`export` inside the project-check sandbox: loading Lake configuration executes
project code. Run `preflight` with no project library search path; it parses only
NDJSON and never imports the project's binary environment.
-/

open Lean Lake

namespace LeanFlow.ProjectCheck

private def standardAxioms : Array Name :=
  #[``propext, ``Classical.choice, ``Quot.sound]

private def isWithin (path directory : System.FilePath) : Bool :=
  directory.normalize.components.isPrefixOf path.normalize.components

/-- Build exactly Lake's default targets and select declarations by their
declaring module's package ownership, rather than by declaration namespace. -/
private def prepareExport : CliM (Environment × List Name × Array Name) := do
  let opts ← getThe LakeOptions
  let ws ← loadWorkspace (← mkLoadConfig opts)
  let buildConfig := mkBuildConfig opts
  ws.runBuild (buildSpecs (← parseTargetSpecs ws [])) buildConfig
  let mods ← ws.runBuild ws.root.defaultModules.fetch buildConfig
  if mods.isEmpty then
    error "Project check found no Lean modules in the default targets. Configure a default Lean library or executable."
  Lean.initSearchPath ws.lakeEnv.lean.sysroot ws.augmentedLeanPath
  -- Private import level is intentional: replay needs complete proof bodies,
  -- including bodies hidden by the module system's public interface.
  let env ← Lean.importModules (mods.map fun mod => {module := mod.name}) {}
  let projectDir ← IO.FS.realPath ws.root.dir
  let buildDir ← IO.FS.realPath ws.root.leanLibDir
  unless isWithin buildDir projectDir do
    error "Project kernel checks require the root package's Lean build directory to stay inside the project. Remove build-directory symlinks or configure a local build directory."
  let mut localModules : Array Name := #[]
  let mut localIndices : Std.HashSet Nat := {}
  for moduleName in env.header.moduleNames, index in [:env.header.moduleNames.size] do
    let importedPath ← Lean.findOLean moduleName
    let importedRealPath ← IO.FS.realPath importedPath
    if let some mod := ws.root.findTargetModule? moduleName then
      let expectedPath := mod.oleanFile.normalize
      let expectedRealPath ← IO.FS.realPath expectedPath
      unless importedRealPath == expectedRealPath && expectedPath == expectedRealPath &&
          isWithin expectedRealPath buildDir do
        error s!"Local module '{moduleName}' did not load its own regular project build artifact. Remove symlinked build artifacts and rebuild the project."
      let sourcePath ← IO.FS.realPath mod.leanFile
      unless isWithin sourcePath projectDir do
        error s!"Local module '{moduleName}' has source outside the project. Configure external source as a dependency before requesting a kernel check."
      localModules := localModules.push moduleName
      localIndices := localIndices.insert index
    else if isWithin importedPath ws.root.leanLibDir || isWithin importedRealPath buildDir then
      -- Lake can silently reuse a manually cached .olean for an unconfigured
      -- import without rebuilding its source. Do not certify that stale code.
      error s!"Imported local module '{moduleName}' is not configured as a Lean library or executable module. Add it to the project's Lake targets before checking."
  let roots := env.constants.toList.filterMap fun (name, _) => do
    let index ← env.getModuleIdxFor? name
    if localIndices.contains index.toNat then some name else none
  if roots.isEmpty then
    error "Project check found no declarations in the default targets' local Lean modules. Add a definition or theorem before requesting a kernel check."
  return (env, roots, localModules)

private def exportProject : CliM PUnit := do
  -- Lake configuration and build messages must not contaminate the NDJSON.
  let (env, roots, localModules) ← IO.withStdout (← IO.getStderr) prepareExport
  IO.eprintln s!"Project kernel check covers {roots.length} local declarations in {localModules.size} modules, plus every dependency used by their types and bodies."
  -- Do not discard private/internal local names: they can contain proofs and
  -- definitions that are not reachable from a public API declaration.
  LeanExport.dumpEnv env (some roots)

/-- Inspect actual exported declarations, not the cached collectAxioms metadata. -/
private def preflight (path : System.FilePath) : IO Unit := do
  unless path.isAbsolute do
    throw <| IO.userError "Project-check preflight requires an absolute export path."
  let exported ← LeanExport.parseStream <| .ofHandle (← IO.FS.Handle.mk path .read)
  if exported.constOrder.isEmpty then
    throw <| IO.userError "Project-check export contains no declarations."
  let used := Lake.Check.usedAxioms exported
  let mut illegal : Array String := #[]
  for name in exported.constOrder do
    if let some (.axiomInfo _) := exported.constMap[name]? then
      unless standardAxioms.contains name do
        let reference := (used.find? (·.1 == name)).map (·.2)
        illegal := illegal.push <| match reference with
          | some ref => s!"Axiom '{name}' is not permitted; it is used by '{ref}'"
          | none => s!"Axiom '{name}' is not permitted; it is declared in the project-check export"
  unless illegal.isEmpty do
    throw <| IO.userError ("\n".intercalate illegal.toList)
  IO.eprintln s!"Axiom preflight passed for {exported.constOrder.size} exported declarations."

end LeanFlow.ProjectCheck

public def main (args : List String) : IO UInt32 := do
  try
    match args with
    | ["export"] => LeanFlow.ProjectCheck.exportProject.run []
    | ["preflight", path] =>
      LeanFlow.ProjectCheck.preflight path
      return 0
    | _ =>
      IO.eprintln "Usage: ProjectCheck.lean export | preflight <absolute-export-file>"
      return 2
  catch error =>
    IO.eprintln s!"error: {error}"
    return 1
