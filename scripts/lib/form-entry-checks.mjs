import assert from 'node:assert/strict'

// Check the rendered browser contract; a clean browser profile cannot verify
// suggestion menus controlled by a user's saved passwords or extensions.
export async function assertManualEntry(field, { secret = false } = {}) {
  await field.waitFor()
  assert.equal(await field.isEditable(), true)
  for (const [attribute, value] of Object.entries({
    autocomplete: secret ? 'new-password' : 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    'data-1p-ignore': 'true',
    'data-lpignore': 'true',
    'data-bwignore': 'true',
    ...(secret ? { type: 'password' } : {}),
  })) {
    assert.equal(await field.getAttribute(attribute), value, attribute)
  }
}
