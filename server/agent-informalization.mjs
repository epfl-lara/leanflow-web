import {
  explicitTheoremNames,
  hasNamedInformalizationRequest,
} from './informalization.mjs'
import {
  mentionedLeanSources,
  projectLeanSourcePaths,
} from './agent-context.mjs'
import {
  addedInformalizationReferences,
  informalizationDocumentChanges,
  informalizationDraftPath,
  verifyInformalizationDocument,
} from './informalization-document.mjs'

const sourceKey = ({ path, name }) => JSON.stringify([path, name])

// A recovery checks each saved (path, name) pair in its original module.
// Ordinary checks can load up to twelve source files in the same Lean worker.
export async function checkInformalizationBatches(request, paths, check) {
  const batches = []
  if (request.priorEntries) {
    for (const [path, entries] of Map.groupBy(
      request.priorEntries,
      (entry) => entry.path,
    ))
      batches.push({ paths: [path], names: entries.map((entry) => entry.name) })
  } else {
    for (let i = 0; i < paths.length; i += 12)
      batches.push({ paths: paths.slice(i, i + 12), names: request.names })
  }
  if (batches.length === 1) return check(batches[0])
  const entries = []
  for (const batch of batches) {
    const result = await check(batch)
    entries.push(...result.entries)
    if (entries.length > 200 || JSON.stringify(entries).length > 100000)
      return {
        status: 'incomplete',
        entries: [],
        detail:
          'The project exceeds the theorem check limit. Name the section or theorems to write up.',
      }
    if (result.status !== 'checked') return { ...result, entries }
  }
  return {
    status: 'checked',
    entries,
    detail: entries.length
      ? 'Lean checked the project’s source proofs.'
      : 'No theorems were found in the project.',
  }
}

// The writer has exited. Reconstruct the paper from saved, hashed sources
// before publishing it or offering the candidate for review.
export async function reviewInformalizationCandidate({
  job,
  snapshot,
  changes,
  sources,
  refreshSources,
  checkSources,
  workspaces,
  texBuilds,
  signal,
  followups,
  onCaptured,
  onProgress,
  savePaper,
}) {
  let draft
  try {
    const paths = informalizationDocumentChanges(changes)
    const primary = informalizationDraftPath(job, snapshot, changes, followups)
    draft = {
      path: primary,
      ...(paths.length > 1 || primary !== paths[0] ? { paths } : {}),
    }
    const clean = await workspaces.verificationCopy(snapshot, changes, {
      signal,
      allowProjectFiles: true,
      onCaptured,
    })
    // A retained draft gets a fresh proof check inside the same guarded
    // verification copy that will supply the final paper build.
    if (refreshSources) {
      const fresh = await refreshSources(clean)
      sources = fresh.sources
      if (
        !fresh.discover &&
        (sources.status !== 'checked' || !sources.entries.length)
      )
        throw new Error(sources.detail)
    }
    const requestedNames = new Set(
      sources.entries.length ? [] : explicitTheoremNames(job.prompt),
    )
    const projectFiles = projectLeanSourcePaths(snapshot)
    const inventory = new Map(
      sources.entries.map((entry) => [sourceKey(entry), entry]),
    )
    const extend = async (request, paths) => {
      const extra = await checkSources(request, clean.root, paths)
      signal.throwIfAborted()
      for (const entry of extra.entries) inventory.set(sourceKey(entry), entry)
      const entries = [...inventory.values()]
      if (extra.status !== 'checked' || !extra.entries.length) {
        sources = { ...extra, entries }
        throw new Error(extra.detail)
      }
      if (entries.length > 200 || JSON.stringify(entries).length > 100000)
        throw new Error(
          'There are too many declarations for one document check. Select a smaller set of theorems.',
        )
      sources = { status: 'checked', entries, detail: extra.detail }
    }
    const seenAttachments = new Set(job.files || [])
    for (const message of followups.filter(
      (entry) => entry.status === 'accepted',
    )) {
      const prompt = message.text
      const mentions = mentionedLeanSources(prompt, projectFiles)
      if (mentions.issue) throw new Error(mentions.issue)
      const added = (message.files || []).filter(
        (file) => projectFiles.includes(file) && !seenAttachments.has(file),
      )
      for (const file of added) seenAttachments.add(file)
      const changedFocus =
        message.proofTarget &&
        JSON.stringify(message.proofTarget) !== JSON.stringify(job.proofTarget)
      if (changedFocus)
        await extend({ proofTarget: message.proofTarget, prompt }, [
          message.proofTarget.path,
        ])
      // Inherited attachments and a still-open editor are context for a
      // follow-up. A newly named file is a request even without an attachment.
      const paths = mentions.paths.length ? mentions.paths : added
      if (paths.length) await extend({ prompt }, paths)
      else if (!changedFocus && hasNamedInformalizationRequest(prompt)) {
        if (projectFiles.length <= 12) await extend({ prompt }, projectFiles)
        else
          for (const name of explicitTheoremNames(prompt))
            requestedNames.add(name)
      }
    }
    // A user can also name another theorem in a text follow-up. Check each
    // additional source reference introduced by the writer against Lean.
    const supplemental = new Map()
    for (const ref of changes.flatMap(addedInformalizationReferences)) {
      if (inventory.has(sourceKey(ref))) continue
      if (!snapshot.files.some((file) => file.path === ref.path))
        throw new Error(
          `The source file for ${ref.name} is missing: ${ref.path}.`,
        )
      if (!supplemental.has(ref.path)) supplemental.set(ref.path, new Set())
      supplemental.get(ref.path).add(ref.name)
    }
    if (
      [...supplemental.values()].reduce((n, names) => n + names.size, 0) > 200
    )
      throw new Error(
        'The draft cites more than 200 additional theorems. Select a smaller scope for this paper.',
      )
    for (const [path, names] of supplemental) {
      await extend({ names: [...names] }, [path])
      for (const name of names)
        if (!inventory.has(sourceKey({ path, name })))
          throw new Error(
            `Lean could not confirm the source reference ${path}#${name}.`,
          )
    }
    if (!sources.entries.length)
      throw new Error(
        'The draft identifies no Lean theorems. Add a source reference to each statement and proof, then check again.',
      )
    for (const name of requestedNames) {
      const exact = sources.entries.filter((entry) => entry.name === name)
      const matches = exact.length
        ? exact
        : sources.entries.filter((entry) => entry.name.endsWith('.' + name))
      if (matches.length !== 1)
        throw new Error(
          `The draft must identify the requested theorem ${name} unambiguously.`,
        )
    }
    onProgress(
      /\.tex$/i.test(primary) ? 'Building document' : 'Checking document',
      primary,
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
    const reason = `Lean checked ${count} source ${count === 1 ? 'proof' : 'proofs'}. ${document.buildId ? 'The PDF is ready.' : 'The Markdown document is ready.'} ${job.liveEdits ? 'Saved the paper in the project.' : 'Review the mathematical wording and apply the document change.'}`
    const report = { sources, reason, document }
    if (job.liveEdits) {
      onProgress('Saving document', document.path)
      await savePaper(report)
    }
    return report
  } catch (error) {
    signal.throwIfAborted()
    return {
      sources,
      draft,
      ...(error.projectRecovery ? { savePending: true } : {}),
      reason:
        error.message +
        (draft
          ? ' The draft is available in Review. Continue in this chat to revise it.'
          : ''),
    }
  }
}
