import { uploadedFiles } from './project-import.mjs'

export function singleFileSource(input, validatePath) {
  const fail = (message) => {
    throw Object.assign(new Error(message), { status: 400 })
  }
  if (
    input.kind !== undefined &&
    !['project', 'single-file'].includes(input.kind)
  )
    fail('Choose a project or a single file.')
  if (input.kind !== 'single-file') {
    if (input.file !== undefined)
      fail('Choose Mathlib Playground to open a .lean file.')
    return null
  }
  if (
    [
      'repository',
      'revision',
      'subdirectory',
      'files',
      'toolchain',
      'preset',
      'libraries',
    ].some((key) => input[key] !== undefined) ||
    input.autoRepair === true
  )
    fail(
      'Mathlib Playground uses the prepared Mathlib environment. Open a project to choose another environment.',
    )
  const [source] = uploadedFiles(
    [
      input.file === undefined
        ? {
            path: 'Scratch.lean',
            content:
              'import Mathlib\n\n-- Write a proof here, or paste your Lean code.\n',
          }
        : input.file,
    ],
    validatePath,
  )
  if (source.path.includes('/') || !source.path.endsWith('.lean'))
    fail('Choose one .lean file, without a folder path.')
  return source
}

export function availablePlaygroundName(base, projects, excludeId) {
  const names = new Set(
    projects
      .filter((project) => project.id !== excludeId)
      .map((project) => project.name),
  )
  if (!names.has(base)) return base
  const stem = base.endsWith('.lean') ? base.slice(0, -5) : base
  const suffix = base.endsWith('.lean') ? '.lean' : ''
  let number = 2
  while (names.has(`${stem}${number}${suffix}`)) number++
  return `${stem}${number}${suffix}`
}
