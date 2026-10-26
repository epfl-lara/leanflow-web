// Select a tested dependency graph, preserving the Mathlib revision required by
// CSLib/Physlib instead of combining independently pinned package versions.
export function projectLibraries(input, definitions) {
  if (input === undefined) return null
  const fail = (message) => {
    throw Object.assign(new Error(message), { status: 400 })
  }
  if (
    !Array.isArray(input) ||
    input.length > 3 ||
    input.some((id) => !['mathlib', 'cslib', 'physlib'].includes(id))
  )
    fail('Choose Mathlib, CSLib, or Physlib.')
  const libraries = [...new Set(input)]
  if (libraries.includes('cslib') && libraries.includes('physlib'))
    fail(
      'The prepared CSLib and Physlib releases require different Lean versions. Choose one of them with Mathlib, or import a repository with a compatible lockfile.',
    )
  const preset = libraries.includes('cslib')
    ? 'cslib'
    : libraries.includes('physlib')
      ? 'physlib'
      : libraries.length
        ? 'mathlib'
        : 'lean'
  const selected = definitions.find((value) => value.id === preset)
  if (!selected) fail('The selected library environment is not configured.')
  return {
    preset,
    libraries,
    imports: libraries.map(
      (id) => ({ mathlib: 'Mathlib', cslib: 'Cslib', physlib: 'Physlib' })[id],
    ),
  }
}

/** Check supported library imports separately from unfinished user proofs. */
export function projectEnvironmentImports(project, manifest) {
  const names = new Set(
    Array.isArray(manifest?.packages)
      ? manifest.packages.map((pkg) => pkg?.name)
      : [],
  )
  if (manifest?.name) names.add(manifest.name)
  if (!project.repository && !project.uploaded && !project.customEnvironment) {
    for (const library of project.libraries || [project.preset])
      names.add(library)
  }
  const imports = ['Lean']
  if (
    names.has('mathlib') ||
    names.has('cslib') ||
    names.has('physlib') ||
    names.has('Physlib')
  )
    imports.push('Mathlib')
  if (names.has('cslib')) imports.push('Cslib')
  if (names.has('physlib') || names.has('Physlib')) imports.push('Physlib')
  return imports
}

export function environmentSmokeProof(imports) {
  return (
    imports.map((name) => `import ${name}`).join('\n') +
    '\nexample (n : Nat) : n + 0 = n := by simp\n'
  )
}

// Lake serializes escaped names with guillemets, but materializes their
// directories using Name.toString (escape := false). Keep target syntax intact
// and decode only safe, single-component dependency directory names.
export function dependencyPackageDirectory(value) {
  if (typeof value !== 'string' || value.length > 128) return null
  const name =
    value.startsWith('«') && value.endsWith('»') ? value.slice(1, -1) : value
  return /^[\p{L}_][\p{L}\p{N}_'-]*$/u.test(name) ? name : null
}

export function dependencyBuildTargets(
  manifest,
  { includeInherited = false, includeMathlib = false } = {},
) {
  if (!Array.isArray(manifest?.packages)) return []
  return manifest.packages
    .filter(
      (pkg) =>
        pkg?.type === 'git' &&
        (includeMathlib || pkg.name !== 'mathlib') &&
        (includeInherited || pkg.inherited !== true) &&
        dependencyPackageDirectory(pkg.name),
    )
    .map((pkg) => `@${pkg.name}`)
}

export function dependencyBuildCommand(target) {
  // A package with no default targets must not make Lake fall back to the
  // root project's proofs. The explicit facet always contributes a build job.
  return ['lake', 'build', `${target}:extraDep`, target]
}
