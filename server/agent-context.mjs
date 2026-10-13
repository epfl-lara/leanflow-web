const MAX_HISTORY = 60_000

// Chat history is server-owned conversation text, never native HOME state or
// privileged protocol roles. A new worker checks the current saved sources.
export function agentConversationContext(job, runs = []) {
  const currentIndex = runs.findIndex((run) => run.id === job.id)
  const previous =
    currentIndex >= 0
      ? runs.slice(0, currentIndex)
      : runs.filter(
          (run) =>
            run.id !== job.id &&
            (!run.createdAt || run.createdAt <= job.createdAt),
        )
  const entries = []
  let used = 0
  for (const run of previous.slice(-12).reverse()) {
    const entry = {
      mode: run.mode,
      user: typeof run.prompt === 'string' ? run.prompt.slice(-8000) : '',
      assistant:
        typeof run.message === 'string' ? run.message.slice(-16_000) : '',
      status: run.status,
      verificationAtThatTime:
        run.verification?.complete === true
          ? 'passed'
          : run.verification
            ? 'did not pass'
            : 'not checked',
    }
    const guidance = []
    let guidanceSize = 0
    for (const followup of (run.followups || [])
      .filter((value) => value.status === 'accepted')
      .slice(-8)
      .reverse()) {
      const text = followup.text.slice(-8000)
      if (guidanceSize + text.length > 16_000) break
      guidance.unshift({
        id: followup.id,
        user: text,
        ...(followup.files?.length ? { files: followup.files } : {}),
      })
      guidanceSize += text.length
    }
    if (guidance.length) entry.additionalUserMessages = guidance
    if (typeof run.error === 'string') entry.error = run.error.slice(0, 2000)
    const size = JSON.stringify(entry).length
    if (used + size > MAX_HISTORY) break
    entries.unshift(entry)
    used += size
  }
  const sections = []
  if (entries.length)
    sections.push(
      'Earlier conversation in this chat (context carried into this fresh assistant run):\n' +
        JSON.stringify(entries, null, 2),
      'Current saved project files are authoritative. Previous proof-check claims are historical context; inspect and check current sources again.',
    )
  if (job.files?.length)
    sections.push(
      'Selected saved project files (relative paths; read their current workspace contents):\n' +
        JSON.stringify(job.files),
    )
  sections.push('Current task:\n' + job.prompt)
  return sections.join('\n\n')
}

export function selectedContextFiles(input, validatePath) {
  if (
    input.files !== undefined &&
    (!Array.isArray(input.files) ||
      input.files.length > 12 ||
      input.files.some((file) => typeof file !== 'string'))
  )
    throw Object.assign(new Error('Select up to 12 project files.'), {
      status: 400,
    })
  const files =
    input.files === undefined ? (input.file ? [input.file] : []) : input.files
  return [...new Set(files.map(validatePath))]
}
