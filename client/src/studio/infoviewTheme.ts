// LeanMonaco exports the active VS Code theme's variables into its same-origin
// infoview iframe. Its webview stylesheet then makes the body transparent, which
// exposes a white browser canvas even when those variables describe a dark theme.
// Give both document surfaces an explicit background using the exported tokens;
// they continue to follow the upstream onDidColorThemeChange event automatically.
const surfaceStyles = `
:root {
  --lemex-infoview-background: #ffffff;
  --lemex-infoview-foreground: #333333;
  color-scheme: light;
}
:root.vscode-dark, :root.vscode-high-contrast {
  --lemex-infoview-background: #1e1e1e;
  --lemex-infoview-foreground: #d4d4d4;
  color-scheme: dark;
}
:root, :root body {
  background-color: var(--vscode-editor-background, var(--lemex-infoview-background));
  color: var(--vscode-editor-foreground, var(--lemex-infoview-foreground));
}
:root { min-height: 100%; }
:root body { min-height: 100vh; }
/* Preserve native dark/high-contrast colors; deepen the light palette so small
   hypothesis names and goal markers remain readable against the white surface. */
:root.vscode-light .goal-hyp { color: #8a5200; }
:root.vscode-light .goal-vdash,
:root.vscode-light .goal-goals { color: #28669c; }
`

export function connectInfoviewTheme(host: HTMLElement): () => void {
  const frames = new Map<HTMLIFrameElement, () => void>()
  const install = (frame: HTMLIFrameElement) => {
    const document = frame.contentDocument
    if (!document?.head || document.getElementById('lemex-infoview-surface'))
      return
    const style = document.createElement('style')
    style.id = 'lemex-infoview-surface'
    style.textContent = surfaceStyles
    document.head.append(style)
  }
  const synchronize = () => {
    for (const frame of host.querySelectorAll('iframe')) {
      if (!frames.has(frame)) {
        const loaded = () => install(frame)
        frame.addEventListener('load', loaded)
        frames.set(frame, () => frame.removeEventListener('load', loaded))
      }
      install(frame)
    }
    for (const [frame, removeListener] of frames) {
      if (!host.contains(frame)) {
        removeListener()
        frames.delete(frame)
      }
    }
  }
  const observer = new MutationObserver(synchronize)
  observer.observe(host, { childList: true, subtree: true })
  synchronize()
  return () => {
    observer.disconnect()
    for (const removeListener of frames.values()) removeListener()
    frames.clear()
  }
}
