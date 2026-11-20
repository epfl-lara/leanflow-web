import { hasNamedInformalizationRequest } from './informalization.mjs'
import { informalizationSourcePaths } from './agent-context.mjs'
import {
  addedInformalizationReferences,
  validateInformalizationOutputPath,
  verifyInformalizationDocument,
} from './informalization-document.mjs'

const sourceKey = ({ path, name }) => JSON.stringify([path, name])

// The writer has exited. Only this review may make the private document
// available for Apply. Reconstruct the candidate from saved, hashed sources.
export async function reviewInformalizationCandidate({
  job,
  snapshot,
  changes,
  sources,
  checkSources,
  workspaces,
  texBuilds,
  signal,
  followups,
  onCaptured,
  onProgress,
}) {
  let draft
  try {
    if (changes.length !== 1 || changes[0].after === null)
      throw new Error(
        'Informalize must create or update one TeX or Markdown document. Keep all other project files unchanged.',
      )
    const change = changes[0]
    validateInformalizationOutputPath(change.path)
    if (change.after?.trim()) draft = { path: change.path }
    const clean = await workspaces.verificationCopy(snapshot, changes, {
      signal,
      allowProjectFiles: true,
      onCaptured,
    })
    const inventory = new Map(
      sources.entries.map((entry) => [sourceKey(entry), entry]),
    )
    const extend = async (request) => {
      const extra = await checkSources(request, clean.root)
      signal.throwIfAborted()
      if (extra.status !== 'checked' || !extra.entries.length) {
        sources = extra
        throw new Error(extra.detail)
      }
      for (const entry of extra.entries) inventory.set(sourceKey(entry), entry)
      const entries = [...inventory.values()]
      if (entries.length > 200 || JSON.stringify(entries).length > 100000)
        throw new Error(
          'There are too many declarations for one document check. Select a smaller set of theorems.',
        )
      sources = { ...sources, entries }
    }
    const originalPaths = new Set([
      ...informalizationSourcePaths(job, snapshot),
      ...(job.files || []),
    ])
    for (const message of followups.filter(
      (entry) => entry.status === 'accepted',
    )) {
      const request = { ...message, prompt: message.text }
      if (message.proofTarget) {
        if (
          JSON.stringify(message.proofTarget) !==
          JSON.stringify(job.proofTarget)
        )
          await extend(request)
      } else {
        // The composer carries earlier attachments forward. Only an added
        // source or an explicit named request extends the checked scope.
        const paths = informalizationSourcePaths(request, snapshot)
        const added = paths.filter((file) => !originalPaths.has(file))
        if (added.length && message.files?.some((file) => added.includes(file)))
          await extend({ ...request, files: added })
        else if (hasNamedInformalizationRequest(message.text))
          await extend({
            ...request,
            files: paths.length
              ? paths
              : [...new Set(sources.entries.map((entry) => entry.path))],
          })
        for (const file of added) originalPaths.add(file)
      }
    }
    // A user can also name another theorem in a text follow-up. Check each
    // additional source reference introduced by the writer against Lean.
    const supplemental = new Map()
    for (const ref of addedInformalizationReferences(change)) {
      if (inventory.has(sourceKey(ref))) continue
      if (!snapshot.files.some((file) => file.path === ref.path))
        throw new Error(
          `The source file for ${ref.name} is missing: ${ref.path}.`,
        )
      if (!supplemental.has(ref.path)) supplemental.set(ref.path, [])
      supplemental.get(ref.path).push(ref.name)
    }
    if (supplemental.size > 12)
      throw new Error('Select up to 12 Lean files for one document check.')
    for (const [path, names] of supplemental) {
      await extend({ files: [path], names })
      for (const name of names)
        if (!inventory.has(sourceKey({ path, name })))
          throw new Error(
            `Lean could not confirm the source reference ${path}#${name}.`,
          )
    }
    onProgress(
      /\.tex$/i.test(change.path) ? 'Building document' : 'Checking document',
      change.path,
    )
    const document = await verifyInformalizationDocument({
      job,
      followups,
      snapshot: clean,
      changes,
      entries: sources.entries,
      texBuilds,
      workspaces,
      signal,
    })
    signal.throwIfAborted()
    const count = sources.entries.length
    const reason = `Lean checked ${count} source ${count === 1 ? 'proof' : 'proofs'}. ${document.buildId ? 'The PDF is ready.' : 'The Markdown document is ready.'} Review the mathematical wording and apply the document change.`
    return { sources, reason, document }
  } catch (error) {
    signal.throwIfAborted()
    return {
      sources,
      draft,
      reason:
        error.message +
        (draft
          ? ' The draft is available in Review. Continue in this chat to revise it.'
          : ''),
    }
  }
}
