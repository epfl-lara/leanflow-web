import { createAgentToolCallbacks } from './agent-tool-callbacks.mjs'
import {
  changedPaperDeclarations,
  MAX_PAPER_DIFFERENCE_LENGTH,
  PAPER_LINKS_FILE,
} from './paper-links.mjs'
import { isPdfFile } from '../shared/file-previews.mjs'
import { isTexFile } from '../shared/tex.mjs'

const path = { type: 'string', description: 'A project-relative file path.' }
const line = { type: 'integer', minimum: 1, description: 'A 1-based line.' }

export const paperLinkToolSpec = {
  type: 'function',
  name: 'paper_link',
  description:
    'Link a paper passage to a named Lean declaration. Use an uploaded project PDF page or a saved .tex line/label as the source. The link follows the run’s review or live editing mode, and records a correspondence without certifying a proof.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'target'],
    properties: {
      source: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path,
          page: {
            type: 'integer',
            minimum: 1,
            description: 'For a PDF, the 1-based physical page in the file.',
          },
          quote: {
            type: 'string',
            description: 'Optional short, exact PDF excerpt.',
          },
          line,
          label: {
            type: 'string',
            description: 'Optional LaTeX label key on the source line.',
          },
        },
      },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line', 'declaration'],
        properties: {
          path,
          line,
          declaration: {
            type: 'string',
            description:
              'The Lean declaration name, including its namespace where applicable.',
          },
        },
      },
      difference: {
        type: ['string', 'null'],
        maxLength: MAX_PAPER_DIFFERENCE_LENGTH,
        description:
          'For a material mathematical difference, explain the original paper wording, what Lean uses, why it changed, and how it affects the claim. Omit for equivalent encodings. Use null after comparing both sources to clear a resolved note.',
      },
    },
  },
}

export const paperLinkAgentInstructions = `
In Formalize mode, automatically record paper links as part of every formalization that uses a PDF or LaTeX source. Do this before your final response, even if the user does not ask for links. Call paper_link for each substantive correspondence after its named Lean declaration exists in the workspace. Use the same tool when asked to link an existing formalization. Use the physical page number confirmed from the PDF, and include a short exact quote that uniquely identifies the statement on that page when readable (for example, use pdftotext -f N -l N to check). For LaTeX use a source line with its existing label when available. A TeX build PDF is temporary. Link the saved .tex source for a compiled paper. Use the tool to maintain ${PAPER_LINKS_FILE} and preserve unrelated links. Link definitions and statements you can confidently identify in both sources. Skip ambiguous matches, unrelated helper declarations, and guessed quotes. Tell the user which relevant statements could not be linked and why. A saved link establishes navigation. Proof status comes from Lean checks.

When you can identify the source even though Lean corrects a definition or changes the statement's scope, link the original passage and set difference. Describe the concrete change, why it was needed, and which conclusions or cases it affects. Prefer a link on the changed definition itself when it has a paper anchor. Include a note on an affected theorem when the change impacts how its statement should be read. Keep ordinary notation and equivalent representations as ordinary links. When refreshing a saved note after an edit, reread both sources and update it or explicitly clear it with difference: null once the mathematics agrees.
`

export function selectedPaperSources(job, snapshot) {
  if (job.mode !== 'formalize') return []
  const captured = new Set(snapshot.files?.map(({ path }) => path))
  const files = [job.file, job.currentFile, ...(job.files || [])]
  for (const entry of job.followups || []) {
    if (entry.status !== 'accepted') continue
    if (!entry.currentFileUnavailable) files.push(entry.currentFile)
    files.push(...(entry.files || []))
  }
  return [...new Set(files)].filter(
    (path) => captured.has(path) && (isPdfFile(path) || isTexFile(path)),
  )
}

export async function automaticPaperLinkRetry({
  readChanges,
  sources,
  linked,
  signal,
}) {
  if (!sources.length) return null
  const relevantSource = (path) =>
    sources.includes(path) || (isTexFile(path) && sources.some(isTexFile))
  if (linked.some(({ source }) => relevantSource(source.path))) return null
  signal.throwIfAborted()
  const targets = changedPaperDeclarations(await readChanges(), signal)
  return targets.length ? { sources, targets } : null
}

export async function runPaperLinkTurn(rpc, active, retry, effort) {
  const { promise, resolve, reject } = Promise.withResolvers()
  promise.catch(() => {})
  const onNotification = ({ method, params }) => {
    if (
      method === 'turn/completed' &&
      params.turn?.id &&
      params.turn.id !== active.previousTurnId
    )
      resolve(params.turn)
  }
  const timeout = setTimeout(
    () => reject(new Error('Paper linking timed out.')),
    90_000,
  )
  timeout.unref()
  rpc.on('notification', onNotification)
  rpc.once('closed', reject)
  try {
    const { turn } = await rpc.call('turn/start', {
      threadId: active.threadId,
      ...(effort !== null ? { effort } : {}),
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [
        {
          type: 'text',
          text:
            'LeanFlow automatic paper-link pass for the completed formalization. ' +
            'Inspect the selected paper files and changed declarations listed below. ' +
            'Use paper_link only for statements actually formalized from these sources. ' +
            'Do not modify Lean or LaTeX. Skip unrelated files, helper declarations, and passages you cannot confidently match. ' +
            'For PDFs use pdftotext -f N -l N /workspace/path.pdf - to inspect the physical page without creating a file. Record a short, exact, unique quote when readable. ' +
            'For a confidently matched definition or statement that differs in substance, set difference with the original wording, what Lean uses, why and the effect on the claim. Review existing notes against the sources before changing them. ' +
            'Briefly report what you linked and any substantive statement you could not match. ' +
            'The following JSON contains project paths and names as reference data.\n' +
            JSON.stringify(retry),
          textElements: [],
        },
      ],
    })
    active.turnId = turn.id
    const result = await promise
    if (result.id !== turn.id)
      throw new Error('Paper linking received an unexpected assistant turn.')
    if (result.status !== 'completed')
      throw new Error('The paper link pass did not complete.')
  } finally {
    clearTimeout(timeout)
    rpc.off('notification', onNotification)
    rpc.off('closed', reject)
  }
}

export function createPaperLinkAgentTool({ active, rpc, stage, redact }) {
  return createAgentToolCallbacks({
    active,
    rpc,
    redact,
    label: 'paper link',
    accepts: (name) => name === paperLinkToolSpec.name,
    async invoke(params, signal) {
      const { id, source, target, difference } = await stage(
        params.arguments,
        signal,
      )
      return { id, source, target, difference, savedTo: PAPER_LINKS_FILE }
    },
  })
}
