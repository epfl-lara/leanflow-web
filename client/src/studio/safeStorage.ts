// Best-effort browser storage for optional state such as preferences.
//
// A browser can refuse storage altogether (blocked site data, some private
// modes) or reject a write once its quota is used. Looking up the storage
// object can throw as well as each operation, so both stay inside one guard.
// Callers must keep working when a helper reports failure.

type StorageKind = 'local' | 'session'

const storageOf = (kind: StorageKind): Storage =>
  kind === 'local' ? localStorage : sessionStorage

/** Returns the stored text, or null when it is absent or cannot be read. */
export function readStoredValue(kind: StorageKind, key: string): string | null {
  try {
    const value = storageOf(kind).getItem(key)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** Returns whether the browser accepted the value. */
export function writeStoredValue(
  kind: StorageKind,
  key: string,
  value: string,
): boolean {
  try {
    storageOf(kind).setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** Returns whether the browser accepted the removal, even of an absent key. */
export function removeStoredValue(kind: StorageKind, key: string): boolean {
  try {
    storageOf(kind).removeItem(key)
    return true
  } catch {
    return false
  }
}
