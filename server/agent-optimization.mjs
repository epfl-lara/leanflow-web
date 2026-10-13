export function optimizationPaths(job) {
  return [...new Set([job.file, ...(job.files || [])].filter(file => typeof file === 'string' && file.endsWith('.lean') && !file.startsWith('.lake/') && file.split('/').at(-1) !== 'lakefile.lean'))]
}

export function optimizationReductions(baseline, candidate) {
  if (!baseline?.available || !candidate?.available) return null
  const delta = (before, after) => Number.isFinite(before) && Number.isFinite(after) ? before - after : null
  const percent = (before, after) => Number.isFinite(before) && before > 0 && Number.isFinite(after) ? (before - after) / before * 100 : null
  return {
    proofTokens: delta(baseline.proofTokens, candidate.proofTokens),
    heartbeatsRaw: delta(baseline.totalHeartbeatsRaw, candidate.totalHeartbeatsRaw),
    heartbeats: delta(baseline.heartbeats, candidate.heartbeats),
    proofTokensPercent: percent(baseline.proofTokens, candidate.proofTokens),
    heartbeatsPercent: percent(baseline.totalHeartbeatsRaw, candidate.totalHeartbeatsRaw),
  }
}

export function optimizationBaselineContext(baseline) {
  return (baseline.available ? 'Saved-proof baseline measured before your edits:\n' : 'Saved-proof cost measurement is unavailable before your edits:\n') + JSON.stringify(baseline, null, 2) +
    '\nThese are measurements for this project and its pinned Lean toolchain. They are not official competition scores or results for other Lean versions. Preserve theorem statements and surrounding code; optimize proof bodies, then check the actual current candidate.'
}
