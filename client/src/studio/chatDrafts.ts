import { useRef, useState } from 'react'
import type { ChatMode } from './chatModes'
import type { ProofTarget } from './proofTarget'

export interface ChatDraft {
  text: string
  files: string[]
  revision: number
  mode: ChatMode
  proofTarget?: ProofTarget
}
export interface DraftSubmission {
  key: string
  revision: number
  text: string
  files: string[]
  proofTarget?: ProofTarget
}

export const proofFocusPrompts = {
  proofs: 'Complete or repair this proof while preserving its statement.',
  optimize: 'Optimize this proof while preserving its statement.',
  search:
    'Explain this proof or definition and find relevant lemmas. Do not edit files.',
}

export function focusDraft(
  current: ChatDraft,
  proofTarget: ProofTarget,
  mode?: ChatMode,
): ChatDraft {
  const nextMode = mode || current.mode
  return {
    ...current,
    proofTarget: { ...proofTarget },
    mode: nextMode,
    text:
      !current.text.trim() ||
      Object.values(proofFocusPrompts).includes(current.text)
        ? proofFocusPrompts[nextMode === 'formalize' ? 'proofs' : nextMode]
        : current.text,
    revision: current.revision + 1,
  }
}

const sameTarget = (a?: ProofTarget, b?: ProofTarget) =>
  a === b ||
  (!!a &&
    !!b &&
    a.path === b.path &&
    a.startLine === b.startLine &&
    a.endLine === b.endLine &&
    a.name === b.name &&
    a.source === b.source)

const sameFiles = (a: string[], b: string[]) =>
  a.length === b.length && a.every((path, index) => path === b[index])

export function clearDraftSubmission(
  current: ChatDraft,
  submission: DraftSubmission,
  clearFiles = false,
): ChatDraft | null {
  if (
    current.revision !== submission.revision ||
    current.text !== submission.text ||
    !sameFiles(current.files, submission.files) ||
    !sameTarget(current.proofTarget, submission.proofTarget)
  )
    return null
  return {
    ...current,
    text: '',
    files: clearFiles ? [] : current.files,
    ...(current.proofTarget ? { proofTarget: undefined } : {}),
    revision: current.revision + 1,
  }
}

export function restoreDraftSubmission(
  current: ChatDraft,
  submission: DraftSubmission,
): ChatDraft | null {
  if (
    current.revision !== submission.revision + 1 ||
    current.text !== '' ||
    current.files.length !== 0 ||
    !!current.proofTarget
  )
    return null
  return {
    ...current,
    text: submission.text,
    files: [...submission.files],
    ...(submission.proofTarget
      ? { proofTarget: { ...submission.proofTarget } }
      : {}),
    revision: current.revision + 1,
  }
}

export const chatDraftKey = (
  user: string,
  project: string,
  chat: string | null,
) =>
  `lemex-draft:${encodeURIComponent(user)}:${encodeURIComponent(project)}:${encodeURIComponent(chat || 'new')}`

export function readChatDraft(key: string): ChatDraft {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null')
    if (value && typeof value.text === 'string' && Array.isArray(value.files))
      return {
        text: value.text,
        files: [
          ...new Set<string>(
            value.files.filter((path: unknown) => typeof path === 'string'),
          ),
        ].slice(0, 12),
        revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
        mode: ['proofs', 'formalize', 'optimize', 'search'].includes(value.mode)
          ? value.mode
          : 'proofs',
        ...(value.proofTarget &&
        typeof value.proofTarget.path === 'string' &&
        typeof value.proofTarget.source === 'string' &&
        value.proofTarget.source.length <= 64_000 &&
        Number.isSafeInteger(value.proofTarget.startLine) &&
        value.proofTarget.startLine > 0 &&
        Number.isSafeInteger(value.proofTarget.endLine) &&
        value.proofTarget.endLine >= value.proofTarget.startLine
          ? {
              proofTarget: {
                path: value.proofTarget.path,
                startLine: value.proofTarget.startLine,
                endLine: value.proofTarget.endLine,
                source: value.proofTarget.source,
                ...(typeof value.proofTarget.name === 'string'
                  ? { name: value.proofTarget.name }
                  : {}),
              },
            }
          : {}),
      }
  } catch {
    /* Unavailable storage or an older invalid draft must not block chat. */
  }
  return { text: '', files: [], revision: 0, mode: 'proofs' }
}

export function useChatDraft(
  user: string,
  project: string,
  chat: string | null,
) {
  const cache = useRef(new Map<string, ChatDraft>())
  const [, render] = useState(0)
  const key = chatDraftKey(user, project, chat)
  const get = (id: string) => {
    if (!cache.current.has(id)) cache.current.set(id, readChatDraft(id))
    return cache.current.get(id)!
  }
  const write = (id: string, value: ChatDraft) => {
    cache.current.set(id, value)
    try {
      localStorage.setItem(id, JSON.stringify(value))
    } catch {
      /* Retain the in-memory draft if browser storage is full. */
    }
    render((value) => value + 1)
  }
  return {
    key,
    // Async recovery can run after a write but before React commits its next
    // render. Read the cache so it sees the user's newest draft immediately.
    get value() {
      return get(key)
    },
    setText: (text: string) =>
      write(key, { ...get(key), text, revision: get(key).revision + 1 }),
    setFiles: (files: string[]) =>
      write(key, { ...get(key), files, revision: get(key).revision + 1 }),
    setMode: (mode: ChatMode) =>
      write(key, { ...get(key), mode, revision: get(key).revision + 1 }),
    clearTarget: () =>
      write(key, {
        ...get(key),
        proofTarget: undefined,
        revision: get(key).revision + 1,
      }),
    focusTarget: (proofTarget: ProofTarget, mode?: ChatMode) =>
      write(key, focusDraft(get(key), proofTarget, mode)),
    capture: (): DraftSubmission => ({
      key,
      ...get(key),
      files: [...get(key).files],
      ...(get(key).proofTarget
        ? { proofTarget: { ...get(key).proofTarget! } }
        : {}),
    }),
    clearSubmitted: (submission: DraftSubmission, clearFiles = false) => {
      const current = get(submission.key)
      const stored = readChatDraft(submission.key)
      if (
        stored.revision > submission.revision ||
        (stored.revision === submission.revision &&
          (stored.text !== submission.text ||
            !sameFiles(stored.files, submission.files) ||
            !sameTarget(stored.proofTarget, submission.proofTarget)))
      )
        return
      const cleared = clearDraftSubmission(current, submission, clearFiles)
      if (cleared) write(submission.key, cleared)
    },
    restoreSubmitted: (submission: DraftSubmission) => {
      const current = get(submission.key),
        stored = readChatDraft(submission.key)
      if (stored.revision > submission.revision + 1) return
      if (
        stored.revision === submission.revision + 1 &&
        (stored.text !== '' ||
          stored.files.length !== 0 ||
          !!stored.proofTarget)
      )
        return
      const restored = restoreDraftSubmission(current, submission)
      if (restored) write(submission.key, restored)
    },
    move: (from: string, to: string) => {
      const current = get(from)
      write(to, current)
      write(from, {
        text: '',
        files: [],
        revision: current.revision + 1,
        mode: 'proofs',
      })
    },
  }
}
