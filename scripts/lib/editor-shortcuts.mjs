// Monaco follows the host platform's document and line navigation bindings.
const mac = process.platform === 'darwin'
export const editorShortcuts = {
  documentStart: mac ? 'Meta+ArrowUp' : 'Control+Home',
  documentEnd: mac ? 'Meta+ArrowDown' : 'Control+End',
  lineStart: mac ? 'Meta+ArrowLeft' : 'Home',
  lineEnd: mac ? 'Meta+ArrowRight' : 'End',
  selectLineEnd: mac ? 'Meta+Shift+ArrowRight' : 'Shift+End',
}
