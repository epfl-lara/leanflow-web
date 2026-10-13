import { useRef, useState } from 'react'
import type { ChatMode } from './chatModes'

export interface ChatDraft {
  text: string
  files: string[]
  revision: number
  mode: ChatMode
}
export interface DraftSubmission {
  key: string
  revision: number
  text: string
  files: string[]
}

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
    !sameFiles(current.files, submission.files)
  )
    return null
  return {
    ...current,
    text: '',
    files: clearFiles ? [] : current.files,
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
    current.files.length !== 0
  )
    return null
  return {
    ...current,
    text: submission.text,
    files: [...submission.files],
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
  const value = get(key)
  return {
    key,
    value,
    setText: (text: string) =>
      write(key, { ...get(key), text, revision: get(key).revision + 1 }),
    setFiles: (files: string[]) =>
      write(key, { ...get(key), files, revision: get(key).revision + 1 }),
    setMode: (mode: ChatMode) =>
      write(key, { ...get(key), mode, revision: get(key).revision + 1 }),
    capture: (): DraftSubmission => ({
      key,
      ...get(key),
      files: [...get(key).files],
    }),
    clearSubmitted: (submission: DraftSubmission, clearFiles = false) => {
      const current = get(submission.key)
      const stored = readChatDraft(submission.key)
      if (
        stored.revision > submission.revision ||
        (stored.revision === submission.revision &&
          (stored.text !== submission.text ||
            !sameFiles(stored.files, submission.files)))
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
        (stored.text !== '' || stored.files.length !== 0)
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
