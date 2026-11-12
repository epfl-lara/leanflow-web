import type { Text } from 'yjs'
export interface DocumentTextEdit {
  start: number
  deleteCount: number
  insert: string
}
export interface DocumentDiffOptions {
  maxComputationTimeMs?: number
  maxOperations?: number
  maxTokens?: number
}
export function documentTextEdit(
  before: string,
  value: string,
): DocumentTextEdit | null
export function documentOffsetAfterEdit(
  offset: number,
  edit: DocumentTextEdit,
): number
export function documentTextEdits(
  before: string,
  value: string,
  options?: DocumentDiffOptions,
): DocumentTextEdit[]
export function replaceDocumentText(
  text: Text,
  value: string,
  origin?: unknown,
  options?: DocumentDiffOptions,
): void
