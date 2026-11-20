// Technical values are entered explicitly, rather than filled from a saved login.
// Browsers and password managers may still override these advisory hints.
export const manualEntryProps = {
  autoComplete: 'off',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': 'true',
} as const

export const secretEntryProps = {
  ...manualEntryProps,
  // Unlike "off", this tells browsers not to fill an existing login password.
  autoComplete: 'new-password',
} as const
