import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'

export type MoveMode = 'rename' | 'move'
export interface MoveSubject {
  path: string
  kind: 'file' | 'folder'
}
/** A pending Rename/Move, bound to the project and account that opened it. */
export interface MoveRequest extends MoveSubject {
  mode: MoveMode
  projectId: string
  userId: string
}

export const PLAYGROUND_MOVE_REASON =
  'Convert this playground to a project to rename or move files.'
export const SETUP_FILE_MOVE_REASON =
  'Project setup files cannot be renamed or moved. Edit them in place instead.'

/** Why Rename and Move are unavailable for `path`, or '' when offered. */
export function moveBlockedReason(path: string, playground: boolean) {
  if (playground) return PLAYGROUND_MOVE_REASON
  return PROJECT_CONFIGURATION_FILES.includes(path)
    ? SETUP_FILE_MOVE_REASON
    : ''
}

/** A request may only run in the project and account that opened it. */
export function moveRequestCurrent(
  request: MoveRequest | null,
  projectId: string | null | undefined,
  userId: string | null | undefined,
): request is MoveRequest {
  return (
    !!request &&
    !!projectId &&
    !!userId &&
    request.projectId === projectId &&
    request.userId === userId
  )
}

function baseName(path: string) {
  return path.split('/').at(-1) ?? path
}

/** Returns a user-facing problem with a proposed destination, or ''. */
export function moveProblem(
  subject: MoveSubject,
  destination: string,
  existing: ReadonlySet<string>,
) {
  const name = baseName(destination)
  if (!name || name === '.' || name === '..' || destination.includes('\\'))
    return 'Enter a name without slashes. Use Move to choose another folder.'
  if (
    PROJECT_CONFIGURATION_FILES.includes(subject.path) ||
    PROJECT_CONFIGURATION_FILES.includes(destination)
  )
    return SETUP_FILE_MOVE_REASON
  if (destination === subject.path)
    return 'The new path is the same as the current one.'
  if (destination.startsWith(subject.path + '/'))
    return 'A folder cannot be moved into itself.'
  if (existing.has(destination))
    return `${destination} already exists. Choose another name or location; nothing is overwritten.`
  return ''
}
