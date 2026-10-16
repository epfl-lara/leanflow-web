export const LEAN_EDIT_DISABLED_MESSAGE =
  'Automatic Lean rename and refactoring are disabled because they can change program meaning. Edit files manually and use Check Project.'

const methods = new Set([
  'textDocument/prepareRename',
  'textDocument/rename',
  'textDocument/codeAction',
  'codeAction/resolve',
  'workspace/executeCommand',
  'workspace/willCreateFiles',
  'workspace/willRenameFiles',
  'workspace/willDeleteFiles',
])

export const isDisabledLeanEditMethod = (method) => methods.has(method)
