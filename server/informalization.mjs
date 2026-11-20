import {
  pinnedAuditEnvironment,
  replayLeanSources,
  standardLeanAxioms,
} from './lean-source-replay.mjs'
import { validateWorkspaceFilePath } from './workspace-paths.mjs'

// This command imports the rebuilt modules. It reads Lean's declaration
// environment, including macro-generated theorems and implicit binders.
const theoremReader = `
set_option pp.deepTerms true
set_option pp.maxSteps 100000
set_option pp.proofs true
open Lean in
private def generatedInductiveTheorem (env : Environment) (name : Name) : Bool :=
  match name with
  | .str parent suffix =>
    (env.isConstructor parent && ["inj", "injEq", "sizeOf_spec", "elim", "noConfusion"].contains suffix) ||
      (isBRecOnRecursor env parent && suffix == "eq")
  | _ => false

-- Imported modules can contain realized equations (e.g. f.eq_1) without
-- an entry in Meta.isEqnThm's current-session reverse lookup. Verify Lean's
-- reserved name, its owning definition, and the left side of the equation.
open Lean in
private def generatedEquation (env : Environment) (info : TheoremVal) : Bool := Id.run do
  let some (owner, suffix) := Meta.declFromEqLikeName env info.name | return false
  let some (_, lhs, _) := info.type.getForallBody.eq? | return false
  return info.name == Meta.mkEqLikeNameFor env owner suffix && lhs.getAppFn.isConstOf owner

open Lean Elab Command in
run_cmd do
  let env ← getEnv
  let mut rows := #[]
  let mut unlocated := #[]
  let mut omitted := 0
  let mut bytes := 0
  for modName in env.header.moduleNames, data in env.header.moduleData do
    unless inventoryModules.contains modName.toString do continue
    for name in data.constNames do
      let some (.thmInfo info) := env.find? name | continue
      let userName := privateToUserName name
      if userName.isInternalOrNum || (← liftCoreM <| Meta.isEqnThm name) then continue
      let some ranges ← findDeclarationRanges? name |
        unless generatedInductiveTheorem env name || generatedEquation env info do
          let row := Json.mkObj [("module", toJson modName.toString), ("name", toJson userName.toString)]
          bytes := bytes + row.compress.utf8ByteSize
          if rows.size + unlocated.size >= 1200 || bytes > 500000 then
            omitted := omitted + 1
          else
            unlocated := unlocated.push row
        continue
      let startLine := ranges.range.pos.line
      let endLine := ranges.range.endPos.line
      if endLine < focusStart || startLine > focusEnd then continue
      if rows.size + unlocated.size >= 1200 || bytes >= 500000 then
        omitted := omitted + 1
        continue
      let st ← liftTermElabM <| Meta.ppExpr info.type
      let rendered := st.pretty
      if rendered.contains '⋯' then
        omitted := omitted + 1
        continue
      let axs ← collectAxioms name
      let row := Json.mkObj [
        ("module", toJson modName.toString), ("name", toJson userName.toString),
        ("startLine", toJson startLine), ("endLine", toJson endLine),
        ("type", toJson rendered), ("axioms", toJson (axs.map fun a => a.toString))]
      bytes := bytes + row.compress.utf8ByteSize
      if bytes > 500000 then omitted := omitted + 1 else rows := rows.push row
  logInfo <| (Json.mkObj [("entries", Json.arr rows), ("unlocated", Json.arr unlocated), ("omitted", toJson omitted)]).compress
`

const inspectTheorems = String.raw`
    inventory={'entries':[], 'unlocated':[], 'omitted':0, 'failed':[p for p in paths if p not in selected.values()]}
    if selected:
        # A legacy-mode import reads private proof bodies for both ordinary and
        # module-system files. Module names were validated before compilation.
        script=pathlib.Path(temp)/'InspectTheorems.lean'
        imports=''.join('import '+'.'.join('«'+part+'»' for part in m.split('.'))+'\n' for m in selected)
        focus=request['focus']
        script.write_text('import Lean\n'+imports+
            'private def inventoryModules : Array String := #'+json.dumps(list(selected),ensure_ascii=False)+'\n'+
            'private def focusStart : Nat := '+str(focus[0])+'\n'+
            'private def focusEnd : Nat := '+str(focus[1])+'\n'+request['reader'])
        proc=subprocess.run([lean,'--json',str(script)],text=True,capture_output=True,env=env)
        if proc.returncode: sys.exit(1)
        answers=[]
        for line in proc.stdout.splitlines():
            try: item=json.loads(line)
            except json.JSONDecodeError: continue
            if item.get('severity')=='information' and item.get('fileName')==str(script):
                answers.append(json.loads(item['data']))
        if len(answers)!=1: sys.exit(1)
        inventory['omitted']=answers[0]['omitted']
        for key in ['entries','unlocated']:
            for entry in answers[0][key]:
                entry['path']=selected[entry.pop('module')]
                inventory[key].append(entry)
        inventory['entries'].sort(key=lambda row:(paths.index(row['path']),row['startLine'],row['endLine'],row['name']))
    print(json.dumps(inventory,ensure_ascii=False))
`

const unavailable = (detail) => ({ status: 'unavailable', entries: [], detail })

const namePart = "(?:«[^»\n]+»|[\\p{L}_][\\p{L}\\p{N}\\p{M}_'!?]*)"
const namePattern = namePart + '(?:\\.' + namePart + ')*'
const wholeFile =
  /\b(?:all|each|every)\s+(?:(?:of\s+)?the\s+)?(?:named\s+)?(?:theorems?|lemmas?|declarations?|statements?|proofs?)\b|\b(?:whole|entire|full)\s+(?:source|files?|projects?|documents?)\b|\b(?:informalize|translate|explain|write\s+up)\s+(?:this|these|the|both)\s+(?:attached\s+)?(?:Lean\s+)?files?\b/i

const translationVerb = '\\b(?:translate|informalize|explain|write\\s+up)'
const explicitRequest = new RegExp(
  '\\b(?:theorem|lemma)\\s+(?:`(' +
    namePattern +
    ')`|(' +
    namePattern +
    ')(?=$|[,.!?;:]|\\s+(?:and|from|in|to)\\b))|' +
    translationVerb +
    '\\s+(?:`(' +
    namePattern +
    ')`|(' +
    namePart +
    '(?:\\.' +
    namePart +
    ')+))',
  'giu',
)

// Only explicit theorem requests can turn an unknown word into a missing
// declaration. Output filenames, citations and surrounding prose do not.
export function* explicitTheoremNames(prompt) {
  if (!prompt || wholeFile.test(prompt)) return
  for (const [
    ,
    quotedTheorem,
    bare,
    quotedTarget,
    qualified,
  ] of prompt.matchAll(explicitRequest)) {
    const name = quotedTheorem ?? bare ?? quotedTarget ?? qualified
    if (
      bare &&
      /^(?:above|below|here|there|statement|proof|from|in|to|and)$/i.test(bare)
    )
      continue
    if (!/\.(?:lean|tex|md|markdown|pdf|docx?|html?|bib)$/i.test(name))
      yield name
  }
}

export function hasNamedInformalizationRequest(prompt) {
  return !explicitTheoremNames(prompt).next().done
}

function selectDeclarations(entries, proofTarget, prompt, issues) {
  if (proofTarget) {
    if (!proofTarget.name) return entries
    const exact = entries.filter(({ name }) => name === proofTarget.name)
    if (exact.length === 1) return exact
    const bySuffix = entries.filter(({ name }) =>
      name.endsWith('.' + proofTarget.name),
    )
    if (bySuffix.length === 1) return bySuffix
    issues.push(
      'The focused name does not identify one declaration on these lines. Select the exact theorem again.',
    )
    return []
  }
  if (!prompt || wholeFile.test(prompt)) return entries
  const named = new Map()
  for (const entry of entries) {
    for (const spelling of new Set([
      entry.name,
      entry.name.split('.').at(-1),
    ])) {
      if (!named.has(spelling)) named.set(spelling, [])
      named.get(spelling).push(entry)
    }
  }
  const tokens = new Set(prompt.match(new RegExp(namePattern, 'gu')))
  const selected = new Set()
  let hasRequest = false
  for (const token of tokens) {
    const matches = named.get(token)
    if (!matches) continue
    hasRequest = true
    if (matches.length === 1) selected.add(matches[0])
    else
      issues.push(
        'The name ' +
          token +
          ' matches multiple declarations. Specify the full name.',
      )
  }
  for (const token of explicitTheoremNames(prompt)) {
    if (!named.has(token)) {
      hasRequest = true
      issues.push(
        'No named theorem ' + token + ' was found in the selected sources.',
      )
    }
  }
  return hasRequest ? entries.filter((entry) => selected.has(entry)) : entries
}

function inventoryReport(inventory, sources, proofTarget, prompt, names) {
  const validReference = (entry) =>
    entry &&
    sources.includes(entry.path) &&
    typeof entry.name === 'string' &&
    entry.name.length > 0
  if (
    !Number.isSafeInteger(inventory.omitted) ||
    inventory.omitted < 0 ||
    !Array.isArray(inventory.entries) ||
    !Array.isArray(inventory.unlocated) ||
    !inventory.unlocated.every(validReference) ||
    !Array.isArray(inventory.failed) ||
    !inventory.failed.every((path) => sources.includes(path))
  )
    return unavailable(
      'Lean returned an incomplete inventory. Retry the source check.',
    )
  const issues = []
  for (const entry of inventory.entries) {
    if (
      !validReference(entry) ||
      typeof entry.type !== 'string' ||
      !entry.type ||
      !Number.isSafeInteger(entry.startLine) ||
      entry.startLine < 1 ||
      !Number.isSafeInteger(entry.endLine) ||
      entry.endLine < entry.startLine ||
      !Array.isArray(entry.axioms) ||
      !entry.axioms.every((value) => typeof value === 'string')
    )
      return unavailable(
        'Lean returned an incomplete declaration. Retry the source check.',
      )
  }
  let selected = selectDeclarations(
    [...inventory.entries, ...inventory.unlocated],
    proofTarget,
    names ? undefined : prompt,
    issues,
  )
  if (names) {
    const exact = new Set(names)
    const found = new Map()
    for (const entry of selected)
      found.set(entry.name, (found.get(entry.name) || 0) + 1)
    for (const name of exact) {
      if (found.get(name) !== 1)
        issues.push(
          'The selected sources do not identify exactly one theorem named ' +
            name +
            '.',
        )
    }
    selected = selected.filter(
      (entry) => exact.has(entry.name) && found.get(entry.name) === 1,
    )
  }
  const entries = []
  const unlocated = []
  const withoutRanges = new Set(inventory.unlocated)
  let size = 0
  let limited = inventory.omitted > 0
  for (const entry of selected) {
    size += JSON.stringify(entry).length
    if (entries.length + unlocated.length >= 200 || size > 100000) {
      limited = true
      break
    }
    if (withoutRanges.has(entry)) {
      unlocated.push({ path: entry.path, name: entry.name })
      continue
    }
    entries.push({
      ...entry,
      status: entry.axioms.every((name) => standardLeanAxioms.includes(name))
        ? 'checked'
        : 'incomplete',
    })
  }
  if (limited)
    issues.push(
      'The full inventory could not fit within the theorem or rendering limit. Select a smaller range and inspect any abbreviated types in Lean.',
    )
  if (inventory.failed.length)
    issues.push(
      'Lean could not compile or replay ' +
        inventory.failed.join(', ') +
        '. Open the source to inspect its diagnostics.',
    )
  if (unlocated.length)
    issues.push(
      'Lean found ' +
        (unlocated.length === 1 ? 'a theorem' : 'theorems') +
        ' without source lines. Select a named theorem with source lines to continue.',
    )
  if (entries.some(({ status }) => status === 'incomplete'))
    issues.push('Some proofs use an admitted result or a nonstandard axiom.')
  return {
    status: issues.length ? 'incomplete' : 'checked',
    entries,
    ...(unlocated.length && { unlocated }),
    ...(inventory.failed.length && { failedPaths: inventory.failed }),
    detail:
      issues.join(' ').slice(0, 2500) ||
      (entries.length
        ? 'Lean replayed the selected proofs and checked their axiom dependencies.'
        : 'No named theorems or lemmas in the selected source range.'),
  }
}

export async function prepareInformalizationSources(
  runtime,
  root,
  { paths = [], proofTarget, prompt, names, signal, onOutput },
) {
  signal?.throwIfAborted()
  if (
    names !== undefined &&
    (!Array.isArray(names) ||
      names.length > 200 ||
      names.some(
        (name) => typeof name !== 'string' || !name || name.length > 1024,
      ))
  )
    return unavailable('Select up to 200 named theorem references to check.')
  const sources = [...new Set(proofTarget ? [proofTarget.path] : paths)]
  if (!sources.length)
    return unavailable(
      'Lemex could not identify a Lean source file. Name the theorem or file you want to write up.',
    )
  try {
    if (
      sources.length > 12 ||
      sources.some((file) => {
        const filename = validateWorkspaceFilePath(file)
        return (
          !filename.endsWith('.lean') ||
          filename.split('/').includes('.lake') ||
          filename.split('/').at(-1) === 'lakefile.lean'
        )
      })
    )
      return unavailable('Select up to 12 project Lean source files to check.')
    const focus = proofTarget
      ? [proofTarget.startLine, proofTarget.endLine]
      : [1, Number.MAX_SAFE_INTEGER]
    if (
      focus.some((line) => !Number.isSafeInteger(line) || line < 1) ||
      focus[0] > focus[1]
    )
      return unavailable('Select the theorem again to check its saved lines.')
    const environment = await pinnedAuditEnvironment(runtime, root, {
      signal,
      readOnlyWorkspace: true,
      writeLakeCache: true,
    })
    signal?.throwIfAborted()
    if (!environment.env)
      return unavailable(
        'The pinned Lean environment could not be loaded. Check project setup.',
      )
    onOutput?.('Checking the selected Lean declarations and their proofs.\n')
    const result = await replayLeanSources(
      runtime,
      root,
      environment.env,
      { paths: sources, focus, reader: theoremReader },
      inspectTheorems,
      { signal, maxOutputBytes: 2 * 1024 * 1024 },
    )
    signal?.throwIfAborted()
    if (result.timedOut)
      return unavailable(
        'Lean reached the three-minute proof-check limit. Checking even one line rebuilds its source file and local imports. Try a file with fewer dependencies or ask the project administrator to review worker capacity.',
      )
    if (result.truncated)
      return unavailable(
        'The theorem inventory exceeded the report size limit. Select a smaller source range.',
      )
    if (result.code !== 0 || result.cancelled)
      return unavailable(
        'The theorem inventory did not finish in the pinned Lean environment. Check project setup and retry.',
      )
    return inventoryReport(
      JSON.parse(result.stdout.trim()),
      sources,
      proofTarget,
      prompt,
      names,
    )
  } catch {
    signal?.throwIfAborted()
    return unavailable(
      'The independent theorem check could not finish. Check project setup and retry.',
    )
  }
}
