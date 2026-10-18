import express from 'express'

// The longest accepted provider key and URL still fit comfortably together.
export const MAX_AUTH_JSON_BYTES = 16 * 1024

export function isPublicAuthRequest(request) {
  return (
    request.method === 'POST' &&
    /^\/api\/(?:login|logout)\/?$/i.test((request.baseUrl || '') + request.path)
  )
}

// Public requests must be bounded before parsing or checking credentials.
export function authRequestJson({ maxConcurrent = 8, timeoutMs = 10000 } = {}) {
  if (
    !Number.isSafeInteger(maxConcurrent) ||
    maxConcurrent <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error('Account request limits must be positive integers.')
  const parse = express.json({ limit: MAX_AUTH_JSON_BYTES })
  let active = 0
  return (request, response, next) => {
    if (!isPublicAuthRequest(request)) return next()
    const reject = (status, message) => {
      // Do not keep reading an unauthenticated body after rejecting it.
      if (!request.complete) {
        response.setHeader('Connection', 'close')
        response.once('finish', () => request.destroy())
      }
      response.status(status).json({ error: message })
    }
    if (active >= maxConcurrent) {
      response.setHeader('Retry-After', '1')
      reject(429, 'Sign-in is busy. Wait a moment and try again.')
      return
    }
    active++
    let settled = false
    const release = () => {
      if (settled) return false
      settled = true
      active--
      clearTimeout(timer)
      request.off('aborted', release)
      response.off('close', release)
      return true
    }
    const timer = setTimeout(() => {
      if (release())
        reject(408, 'Sign-in details took too long to arrive. Try again.')
    }, timeoutMs)
    timer.unref()
    request.once('aborted', release)
    response.once('close', release)
    parse(request, response, (error) => {
      if (!release()) return
      if (error) {
        const status = error.status || 400
        reject(
          status,
          status === 413
            ? 'Sign-in details are too large. Check the access token and API key.'
            : 'Sign-in details could not be read. Send valid JSON and try again.',
        )
        return
      }
      next()
    })
  }
}
