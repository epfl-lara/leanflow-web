import { registerExtension } from 'vscode/extensions'

const themeNames = {
  light: 'GitHub Light Default',
  dark: 'GitHub Dark Default',
}

// GitHub Theme 6.3.5, MIT: https://github.com/primer/github-vscode-theme
// Only the two compiled theme files are bundled; no extension code is loaded.
export async function registerLeanEditorThemes() {
  const extension = registerExtension(
    {
      name: 'editor-themes',
      publisher: 'leanflow',
      version: '1.0.0',
      engines: { vscode: '*' },
      contributes: {
        themes: [
          {
            id: themeNames.light,
            label: themeNames.light,
            uiTheme: 'vs',
            path: './themes/github-light-default.json',
          },
          {
            id: themeNames.dark,
            label: themeNames.dark,
            uiTheme: 'vs-dark',
            path: './themes/github-dark-default.json',
          },
        ],
        // Map Lean's semantic tokens to the theme's own syntax categories.
        // Locals, projections and incomplete proofs keep useful distinctions
        // without maintaining a separate Lean color palette.
        semanticTokenScopes: [
          {
            language: 'lean4',
            scopes: {
              variable: ['variable'],
              property: ['support.variable'],
              leanSorryLike: ['invalid.illegal'],
            },
          },
        ],
      },
    },
    1, // ExtensionHostKind.LocalProcess; use Lean's existing extension host.
  )
  extension.registerFileUrl(
    './themes/github-light-default.json',
    new URL('./themes/github-light-default.json', import.meta.url).href,
  )
  extension.registerFileUrl(
    './themes/github-dark-default.json',
    new URL('./themes/github-dark-default.json', import.meta.url).href,
  )
  await extension.whenReady()
}

export function leanEditorTheme(theme: 'light' | 'dark') {
  return {
    'workbench.colorTheme': themeNames[theme],
    // The compiled themes omit GitHub's intended 20% accent selection overlay.
    // Restore it so Monaco's opaque fallback does not obscure muted comments.
    'workbench.colorCustomizations': {
      '[GitHub Light Default]': { 'editor.selectionBackground': '#0969da33' },
      '[GitHub Dark Default]': { 'editor.selectionBackground': '#2f81f733' },
    },
  }
}
