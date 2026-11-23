export type EditorQueueNotice =
  | { state: 'waiting'; position: number; total: number }
  | { state: 'starting' | 'active' }
export const REPOSITORY_TREE_CHANGED: 'Project files were added, removed or renamed.'
export const EDITOR_QUEUE_METHOD: '$/leanflow/editorQueue'
export const editorAdmissionReasons: Readonly<{
  queueFull: string
  accountQueueFull: string
  expired: string
  closing: string
}>
export function editorQueueNotice(value: unknown): EditorQueueNotice | null
