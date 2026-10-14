export function validateGitBranch(
  value,
  { message = 'Choose a valid branch name.' } = {},
) {
  if (
    typeof value !== 'string' ||
    value === 'HEAD' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part.startsWith('.') ||
          part.endsWith('.') ||
          part.endsWith('.lock'),
      )
  )
    throw Object.assign(new Error(message), { status: 400 })
  return value
}
