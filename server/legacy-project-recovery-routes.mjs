import { downloadDisposition } from './project-downloads.mjs'

export function recoveryIdleCheck(
  id,
  actor,
  { requireNoActiveWork, managers, events },
) {
  return () => {
    requireNoActiveWork(id, actor)
    if (
      managers.some((manager) =>
        [...(manager?.active?.keys() || [])].some(
          (runId) => events.getMetadata(runId).projectId === id,
        ),
      )
    )
      throw Object.assign(
        new Error(
          'Project work is still finishing. Wait before recovering files.',
        ),
        { status: 409 },
      )
  }
}

export function installLegacyRecoveryRoutes(app, dependencies) {
  const { workspaces, publicProject } = dependencies
  const base = '/api/projects/:id/file-recovery/legacy'
  app.get(base, async (req, res) => {
    workspaces.requireAdmin(req.params.id, req.user.id)
    res.setHeader('Cache-Control', 'no-store')
    const query = req.query
    if (
      Object.keys(query).some(
        (key) =>
          !['cursor', 'recordId', 'fileOffset', 'expectedUserId'].includes(key),
      ) ||
      ['cursor', 'recordId', 'fileOffset'].some(
        (key) => query[key] !== undefined && typeof query[key] !== 'string',
      ) ||
      (query.fileOffset !== undefined &&
        !/^(0|[1-9][0-9]{0,4})$/.test(query.fileOffset))
    )
      throw Object.assign(new Error('Choose a valid recovery page.'), {
        status: 400,
      })
    const controller = new AbortController()
    const cancel = () => controller.abort()
    req.once('aborted', cancel)
    res.once('close', cancel)
    try {
      res.json(
        await workspaces.legacyFileRecovery(req.params.id, req.user.id, {
          cursor: query.cursor,
          recordId: query.recordId,
          fileOffset:
            query.fileOffset === undefined ? 0 : Number(query.fileOffset),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]),
        }),
      )
    } finally {
      req.off('aborted', cancel)
      res.off('close', cancel)
    }
  })
  app.get(`${base}/:transactionId/original`, async (req, res) => {
    const filename = req.query.path
    if (typeof filename !== 'string')
      throw Object.assign(
        new Error('Choose an original project file to download.'),
        { status: 400 },
      )
    const content = await workspaces.legacyRecoveryOriginal(
      req.params.id,
      req.user.id,
      req.params.transactionId,
      filename,
    )
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader(
      'Content-Disposition',
      downloadDisposition(filename.split('/').at(-1)),
    )
    res.send(content)
  })
  app.post(`${base}/:transactionId`, async (req, res) => {
    const input = req.body
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['revision', 'decision'].includes(key))
    )
      throw Object.assign(
        new Error('Refresh the file recovery review and choose an action.'),
        { status: 400 },
      )
    const assertIdle = recoveryIdleCheck(
      req.params.id,
      req.user.id,
      dependencies,
    )
    workspaces.requireAdmin(req.params.id, req.user.id)
    assertIdle()
    const project = await workspaces.resolveLegacyFileRecovery(
      req.params.id,
      req.user.id,
      req.params.transactionId,
      input,
      { assertIdle },
    )
    res.json(publicProject(project))
  })
}
