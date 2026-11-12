interface HistoryModel {
  undo: () => void | Promise<void>
  redo: () => void | Promise<void>
}

function historyModel(value: unknown): value is HistoryModel {
  return (
    !!value &&
    typeof value === 'object' &&
    'undo' in value &&
    typeof value.undo === 'function' &&
    'redo' in value &&
    typeof value.redo === 'function'
  )
}

// Monaco's keyboard commands, context menu and editor.trigger all reach the
// model undo/redo methods. A live document must own all three paths so
// its local undo stack can never replay a collaborator's imported edits.
export function installCollaborativeEditorUndo(
  candidate: unknown,
  path: string,
  callbacks: () => {
    undo?: (path: string) => boolean
    redo?: (path: string) => boolean
  },
) {
  // Monaco exposes these commands on its runtime model, but not ITextModel.
  // Validate this pinned-version hook before replacing per-instance methods.
  if (!historyModel(candidate))
    throw new Error(
      'This editor version cannot safely undo shared edits. Restore the pinned editor packages before retrying.',
    )
  const model = candidate
  const undo = model.undo,
    redo = model.redo
  const ownUndo = () => {
    if (!callbacks().undo?.(path)) return undo.call(model)
  }
  const ownRedo = () => {
    if (!callbacks().redo?.(path)) return redo.call(model)
  }
  model.undo = ownUndo
  model.redo = ownRedo
  return {
    dispose() {
      if (model.undo === ownUndo) model.undo = undo
      if (model.redo === ownRedo) model.redo = redo
    },
  }
}
