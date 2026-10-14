export type ChatMode = 'proofs' | 'formalize' | 'optimize' | 'search'

export const chatModes: {
  id: ChatMode
  name: string
  hint: string
  placeholder: string
  suggestions: { label: string; prompt: string }[]
}[] = [
  {
    id: 'search',
    name: 'Ask & Search',
    hint: 'Ask questions, understand proofs and definitions, find lemmas, or work on project files. Requested edits are reviewed before applying.',
    placeholder: 'Ask a question or describe a task for your project…',
    suggestions: [
      {
        label: 'Explain this proof',
        prompt:
          'Explain the selected proof and its main steps. Do not edit files.',
      },
      {
        label: 'Explain a definition',
        prompt:
          'Explain the selected definition, its meaning, and how it is used. Include a simple example. Do not edit files.',
      },
      {
        label: 'Find useful lemmas',
        prompt:
          'Find library lemmas relevant to the selected theorem or goal. Explain how they could help without editing files.',
      },
      {
        label: 'Organize project notes',
        prompt:
          'Organize the project notes into a clear Markdown summary. Preserve the information and prepare the file changes for review.',
      },
    ],
  },
  {
    id: 'proofs',
    name: 'Proofs',
    hint: 'Find, complete, or repair a proof while preserving its statement.',
    placeholder: 'Describe the proof or Lean error you want help with…',
    suggestions: [
      {
        label: 'Complete the proof',
        prompt:
          'Find and verify a complete proof of the selected theorem. Preserve its statement.',
      },
      {
        label: 'Fix Lean errors',
        prompt:
          'Fix the Lean errors in this file. Preserve the theorem statements and verify the result.',
      },
    ],
  },
  {
    id: 'formalize',
    name: 'Formalize',
    hint: 'Turn a mathematical statement or argument into Lean.',
    placeholder: 'Describe the statement and argument you want to formalize…',
    suggestions: [
      {
        label: 'Formalize a statement',
        prompt: 'Formalize the following mathematical statement in Lean:\n\n',
      },
      {
        label: 'Formalize an argument',
        prompt:
          'Formalize this statement and proof outline in Lean:\n\nStatement:\n\nProof outline:\n',
      },
    ],
  },
  {
    id: 'optimize',
    name: 'Optimize',
    hint: 'Improve a valid proof; compare tokens and Lean heartbeats.',
    placeholder: 'Describe how you want to improve this proof…',
    suggestions: [
      {
        label: 'Shorten the proof',
        prompt:
          'Reduce the proof tokens using existing lemmas and simpler steps. Preserve the exact statement, verify the proof, and compare tokens and heartbeats.',
      },
      {
        label: 'Reduce heartbeats',
        prompt:
          'Reduce elaboration heartbeats using focused tactics and existing lemmas. Preserve the exact statement, verify the proof, and compare heartbeats and tokens.',
      },
    ],
  },
]

export function modeName(mode?: string) {
  return ['repair', 'prove', 'proofs'].includes(mode || '')
    ? 'Proofs'
    : chatModes.find((item) => item.id === mode)?.name || 'Lemex'
}
