import { SMALL_SOURCE_JSON_BYTES } from '../shared/source-limits.mjs'

const releaseAdmission = Symbol('releaseSourceAdmission')

// Only routes that can receive full source text use the bulk-body allowance.
export function sourceBodyKind(request) {
  // Match Express's default case-insensitive routes and optional trailing slash.
  const pathname = request.path.replace(/\/$/, '').toLowerCase()
  if (
    request.method === 'POST' &&
    (pathname === '/api/projects' ||
      /^\/api\/projects\/[^/]+\/upload$/.test(pathname))
  )
    return 'upload'
  if (
    request.method === 'PUT' &&
    /^\/api\/projects\/[^/]+\/file$/.test(pathname)
  )
    return 'source'
  return null
}

export function isSmallSourceBody(request) {
  const length = request.headers['content-length']
  const encoding = request.headers['content-encoding']?.toLowerCase()
  // Compressed and unknown-length input uses bulk admission; its decoded body
  // can be much larger than the bytes declared on the wire.
  return (
    typeof length === 'string' &&
    /^\d+$/.test(length) &&
    Number.isSafeInteger(Number(length)) &&
    Number(length) <= SMALL_SOURCE_JSON_BYTES &&
    (!encoding || encoding === 'identity') &&
    !request.headers['transfer-encoding']
  )
}

export function sourceRequestAdmission({
  bulk = 2,
  bulkPerUser = 1,
  small = 8,
  smallPerUser = 2,
} = {}) {
  for (const limit of [bulk, bulkPerUser, small, smallPerUser])
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error('Source request capacity must be a positive integer.')
  const lanes = {
    bulk: { limit: bulk, perUser: bulkPerUser, active: 0, users: new Map() },
    small: { limit: small, perUser: smallPerUser, active: 0, users: new Map() },
  }
  return (request, response, next) => {
    const kind = sourceBodyKind(request)
    if (!kind) return next()
    const lane = lanes[isSmallSourceBody(request) ? 'small' : 'bulk']
    const owner = request.user.id
    const owned = lane.users.get(owner) || 0
    if (lane.active >= lane.limit || owned >= lane.perUser) {
      response.setHeader('Retry-After', '1')
      return response.status(429).json({
        error:
          kind === 'source'
            ? 'Source saves are busy. Wait a moment and try again. Your unsaved edits are preserved.'
            : 'Project creation and uploads are busy. Wait a moment and try again.',
      })
    }
    lane.active++
    lane.users.set(owner, owned + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      lane.active--
      const remaining = lane.users.get(owner) - 1
      if (remaining) lane.users.set(owner, remaining)
      else lane.users.delete(owner)
      response.off('finish', release)
      response.off('close', onClose)
      delete request[releaseAdmission]
    }
    const onClose = () => {
      if (!request.complete) release()
    }
    request[releaseAdmission] = release
    response.once('finish', release)
    response.once('close', onClose)
    next()
  }
}

export function finishSourceRequest(request) {
  request[releaseAdmission]?.()
}

// Hold parsed bodies until their operation ends, including disconnected saves.
export function sourceRequestHandler(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response, next)
    } finally {
      finishSourceRequest(request)
    }
  }
}
