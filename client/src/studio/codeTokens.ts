export interface CodeToken {
  text: string
  kind?: string
}

// A small display lexer for Lean snippets. It does not elaborate code or claim
// that a token is a valid declaration. Unsupported/large blocks stay plain text.
const keywords = new Set(
  (
    'import prelude theorem lemma def abbrev example opaque axiom ' +
    'inductive structure class instance namespace end section variable variables ' +
    'universe universes open scoped export attribute private protected noncomputable ' +
    'unsafe partial mutual deriving where extends set_option notation syntax macro ' +
    'elab by sorry admit let have show from fun forall match with if then else do ' +
    'return in at as calc suffices termination_by decreasing_by'
  ).split(' '),
)
const tactics = new Set(
  (
    'simp simpa simp_all dsimp rfl exact apply refine intro intros ' +
    'ext cases rcases obtain constructor induction rw rintro unfold assumption ' +
    'contradiction omega aesop ring ring_nf linarith nlinarith norm_num decide ' +
    'tauto trivial first all_goals any_goals repeat try fail_if_success done ' +
    'change specialize generalize revert subst conv congr'
  ).split(' '),
)

export function codeTokens(source: string, language: string): CodeToken[] {
  if (
    source.length > 40_000 ||
    !['lean', 'lean4', 'diff', 'patch'].includes(language)
  )
    return [{ text: source }]
  if (language === 'diff' || language === 'patch')
    return (source.match(/[^\n]*\n|[^\n]+$/g) || []).map((text) => ({
      text,
      kind: text.startsWith('+')
        ? 'added'
        : text.startsWith('-')
          ? 'removed'
          : text.startsWith('@@')
            ? 'keyword'
            : undefined,
    }))
  const result: CodeToken[] = []
  const add = (text: string, kind?: string) => {
    const previous = result.at(-1)
    if (previous && previous.kind === kind) previous.text += text
    else result.push({ text, kind })
  }
  // Sticky matching keeps the scan linear, including partially streamed code.
  const token =
    /--[^\n]*|"(?:[^"\\]|\\[\s\S])*(?:"|$)|[\p{L}_][\p{L}\p{N}_'!?]*|\d+(?:\.\d+)?|\s+|[^]/uy
  for (let index = 0; index < source.length;) {
    if (source.startsWith('/-', index)) {
      const start = index
      let depth = 1
      index += 2
      while (index < source.length && depth) {
        if (source.startsWith('/-', index)) {
          depth++
          index += 2
        } else if (source.startsWith('-/', index)) {
          depth--
          index += 2
        } else index++
      }
      add(source.slice(start, index), 'comment')
      continue
    }
    token.lastIndex = index
    const value = token.exec(source)?.[0] || source[index]
    index += value.length
    add(
      value,
      value.startsWith('--')
        ? 'comment'
        : value.startsWith('"')
          ? 'string'
          : ['sorry', 'admit'].includes(value)
            ? 'unfinished'
            : keywords.has(value)
              ? 'keyword'
              : tactics.has(value)
                ? 'tactic'
                : /^\d/.test(value)
                  ? 'number'
                  : undefined,
    )
  }
  return result
}
