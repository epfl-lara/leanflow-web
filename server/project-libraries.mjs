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
