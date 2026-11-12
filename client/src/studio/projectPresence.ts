export interface ProjectSelection {
  path: string
  anchor: number
  head: number
}

export interface ProjectPeer extends ProjectSelection {
  clientId: string
  userId: string
  name: string
  documentId: string
}

function projectPeer(value: unknown): value is ProjectPeer {
  if (!value || typeof value !== 'object') return false
  return (
    'clientId' in value &&
    typeof value.clientId === 'string' &&
    'userId' in value &&
    typeof value.userId === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'documentId' in value &&
    typeof value.documentId === 'string' &&
    'anchor' in value &&
    typeof value.anchor === 'number' &&
    Number.isSafeInteger(value.anchor) &&
    value.anchor >= 0 &&
    'head' in value &&
    typeof value.head === 'number' &&
    Number.isSafeInteger(value.head) &&
    value.head >= 0
  )
}

export function projectPeers(value: unknown): ProjectPeer[] | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('peers' in value) ||
    !Array.isArray(value.peers) ||
    !value.peers.every(projectPeer)
  )
    return null
  return value.peers
}

// Account identity keeps a person's color consistent across files and visits.
export function collaboratorHue(userId: string): number {
  let hash = 2166136261
  for (const character of userId) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 360
}
