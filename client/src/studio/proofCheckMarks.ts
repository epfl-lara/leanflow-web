import type { ProofDeclaration } from './proofTarget'

export const proofCheckMarks = {
  checked: {
    label: 'Lean checked',
    priority: 1,
    title:
      'Lean finished checking this declaration without warnings or errors.',
  },
  warning: {
    label: 'Lean warning',
    priority: 3,
    title:
      'This declaration contains a proof placeholder or has a Lean warning. Review the proof and Goals & diagnostics.',
  },
  error: {
    label: 'Lean error',
    priority: 4,
    title:
      'Lean reported an error in this declaration. See Goals & diagnostics.',
  },
  pending: {
    label: 'Awaiting Lean',
    priority: 2,
    title: 'Waiting for Lean to finish checking this declaration.',
  },
}

export function proofCheckMark(declaration: ProofDeclaration) {
  if (
    declaration.kind === 'theorem' ||
    declaration.kind === 'lemma' ||
    declaration.kind === 'example'
  )
    return declaration.checkStatus ?? 'pending'
}
