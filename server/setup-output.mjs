export function setupCommandLabel(args, { gitCommand = args[1] } = {}) {
  if (args[0] === 'lake') {
    if (args[1] === 'update') return 'Resolving project dependencies'
    if (args[1] === 'build')
      return args[2]
        ? `Building dependency ${args[2].replace(/^@/, '')}`
        : 'Building project modules'
    if (args.at(-1) === '--version')
      return 'Preparing pinned dependencies and checking Lean'
    if (args.at(-1) === '--stdin') return 'Testing library imports with Lean'
  }
  if (args[0] === 'git') {
    if (gitCommand === 'clone') return 'Cloning the repository'
    if (gitCommand === 'fetch') return `Fetching revision ${args.at(-1)}`
    if (gitCommand === 'checkout') return 'Checking out the selected revision'
    if (gitCommand === 'init') return 'Initializing project source control'
  }
  return null
}

// Keep compiler output intact and put a named boundary around each setup step.
export async function runSetupStep(label, run, { onOutput, signal } = {}) {
  signal?.throwIfAborted()
  if (!label) return run()
  const started = Date.now()
  onOutput?.(`\nStarting: ${label}.\n`)
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
  try {
    const result = await run()
    signal?.throwIfAborted()
    onOutput?.(
      `${result?.code !== undefined && result.code !== 0 ? 'Failed' : 'Completed'}: ${label} (${elapsed()}).\n`,
    )
    return result
  } catch (error) {
    onOutput?.(
      `${signal?.aborted ? 'Stopped' : 'Failed'}: ${label} (${elapsed()}).\n`,
    )
    throw error
  }
}
