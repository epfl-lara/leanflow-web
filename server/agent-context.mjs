import { proofTargetContext, proofTargetReference } from './proof-target.mjs'
import { isPdfFile } from '../shared/file-previews.mjs'

const MAX_HISTORY = 60_000

// One parseable envelope keeps source text and user-supplied labels from
// impersonating app metadata. null means an automatic app event, not a new user task.
export function agentMessageContext(
  userMessage,
  sections = [],
  savedUserGuidance,
) {
  return JSON.stringify(
    {
      leanflowContext: {
        sections: sections.filter(Boolean),
        ...(savedUserGuidance?.trim() ? { savedUserGuidance } : {}),
      },
      userMessage,
    },
    null,
    2,
  )
}

export function currentEditorFile(input, validatePath) {
  const file = input.currentFile === undefined ? input.file : input.currentFile
  if (file === undefined || file === null) return null
  if (typeof file !== 'string' || !file)
    throw Object.assign(new Error('Invalid current editor file.'), {
      status: 400,
    })
  return validatePath(file)
}

export function currentEditorContext(file) {
  return file
    ? 'Open file in the user’s editor (included automatically; relative path):\n' +
        JSON.stringify(file) +
        '\nInspect the corresponding file in your working project when relevant. During an active run, the editor may contain newer saved or unsaved changes than your working copy.' +
        (isPdfFile(file)
          ? '\nThis PDF’s path is supplied as context; its contents are not attached. Use an available PDF reader, or explain if PDF reading is unavailable.'
          : '')
    : ''
}

// Chat history is server-owned conversation text, never native HOME state or
// privileged protocol roles. A new worker checks the current saved sources.
export function agentConversationContext(
  job,
  runs = [],
  { sections: additionalSections = [], savedUserGuidance } = {},
) {
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
      ...(run.currentFile ? { currentFile: run.currentFile } : {}),
      ...(run.proofTarget
        ? { proofTarget: proofTargetReference(run.proofTarget) }
        : {}),
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
        ...(followup.currentFile && !followup.currentFileUnavailable
          ? { currentFile: followup.currentFile }
          : {}),
        ...(followup.files?.length ? { files: followup.files } : {}),
        ...(followup.proofTarget
          ? { proofTarget: proofTargetReference(followup.proofTarget) }
          : {}),
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
  const editorContext = currentEditorContext(
    job.currentFile === undefined ? job.file : job.currentFile,
  )
  if (editorContext) sections.push(editorContext)
  if (job.proofTarget)
    sections.push(proofTargetContext(job.proofTarget, job.mode))
  return agentMessageContext(
    job.prompt,
    [...sections, ...additionalSections],
    savedUserGuidance,
  )
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
