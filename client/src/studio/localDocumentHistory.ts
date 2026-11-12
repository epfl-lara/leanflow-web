import * as Y from 'yjs'
import { documentTextEdit } from '../../../shared/document-text.mjs'
import type { OpenFile } from './api'

type FileState = Pick<OpenFile, 'content' | 'savedContent' | 'generation'>

// A retired live document can still own local undo while REST saves use CAS.
// Its identities never leave this browser again. Authoritative replacements
// reset the history so an old local undo cannot restore a collaborator's text.
export class LocalDocumentHistory {
  private savedContent: string
  private generation: number
  private discardVersion: number
  private submitted: string | undefined

  constructor(
    private doc: Y.Doc,
    private manager: Y.UndoManager,
    file: FileState,
    discardVersion: number,
    private origin: symbol,
  ) {
    this.savedContent = file.savedContent
    this.generation = file.generation
    this.discardVersion = discardVersion
    this.manager.stopCapturing()
    this.synchronize(file, discardVersion)
  }

  private replace(value: string, origin?: symbol) {
    const text = this.doc.getText('source')
    const edit = documentTextEdit(text.toString(), value)
    if (!edit) return
    this.doc.transact(() => {
      if (edit.deleteCount) text.delete(edit.start, edit.deleteCount)
      if (edit.insert) text.insert(edit.start, edit.insert)
    }, origin)
  }

  synchronize(file: FileState, discardVersion: number) {
    const replaced =
      file.generation !== this.generation ||
      discardVersion !== this.discardVersion ||
      (file.savedContent !== this.savedContent &&
        file.savedContent !== this.submitted)
    if (replaced) {
      this.manager.clear()
      this.replace(file.savedContent)
      this.manager.stopCapturing()
    }
    if (file.savedContent !== this.savedContent) this.submitted = undefined
    this.savedContent = file.savedContent
    this.generation = file.generation
    this.discardVersion = discardVersion
    this.replace(file.content, this.origin)
  }

  markSubmitted() {
    this.submitted = this.doc.getText('source').toString()
  }

  change(action: 'undo' | 'redo') {
    this.manager.stopCapturing()
    const changed =
      action === 'undo' ? this.manager.undo() : this.manager.redo()
    return changed ? this.doc.getText('source').toString() : undefined
  }

  dispose() {
    this.manager.destroy()
    this.doc.destroy()
  }
}
