export function outlineCode(
  content: string,
  options?: { keepQuotedIdentifiers?: boolean },
): string
export function declarationKeyword(source: string):
  | {
      kind:
        | 'theorem'
        | 'lemma'
        | 'def'
        | 'example'
        | 'structure'
        | 'inductive'
        | 'abbrev'
        | 'instance'
      offset: number
    }
  | undefined
