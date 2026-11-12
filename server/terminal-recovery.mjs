import {
  createProjectDownload,
  downloadDisposition,
  isProjectDownloadPath,
  listProjectDownloadFiles,
} from './project-downloads.mjs'

export function installTerminalRecoveryRoutes(
  app,
  workspaces,
  { downloadLimits } = {},
) {
  const active = new Set()
  app.get('/api/terminal-recoveries', async (req, res) => {
    res.json(await workspaces.personalTerminalRecoveries(req.user.id))
  })
  app.get('/api/projects/:id/terminal-recoveries', async (req, res) => {
    res.json(await workspaces.terminalRecoveries(req.params.id, req.user.id))
  })
  app.delete(
    '/api/projects/:id/terminal-recoveries/:runId',
    async (req, res) => {
      res.json(
        await workspaces.deleteTerminalRecovery(
          req.params.id,
          req.user.id,
          req.params.runId,
        ),
      )
    },
  )
  const recoverFiles = (listing) => async (req, res) => {
    const { id, runId } = req.params
    const actor = req.user.id
    const recovery = await workspaces.terminalRecovery(id, actor, runId)
    const filename = req.query.path
    if (
      Object.keys(req.query).some(
        (key) => key !== 'expectedUserId' && (listing || key !== 'path'),
      ) ||
      (filename !== undefined && !isProjectDownloadPath(filename))
    )
      throw Object.assign(new Error('Choose a permitted recovery file.'), {
        status: 400,
      })
    if (active.has(actor) || active.size >= 2) {
      res.setHeader('Retry-After', '1')
      return res.status(429).json({
        error:
          'Recovery downloads are busy. Wait for your current download and retry.',
      })
    }
    active.add(actor)
    const controller = new AbortController()
    const close = () => controller.abort()
    res.once('close', close)
    try {
      const files = {
        get: () => {
          workspaces.assertActorActive?.(actor)
          return recovery
        },
        readDownloadFile: (_id, _actor, filename, options) =>
          workspaces.readTerminalRecoveryFile(
            id,
            actor,
            runId,
            filename,
            options,
          ),
      }
      if (listing) {
        const result = await listProjectDownloadFiles(files, id, actor, {
          signal: controller.signal,
          limits: downloadLimits,
        })
        await workspaces.terminalRecovery(id, actor, runId)
        if (!res.destroyed)
          await new Promise((resolve) => {
            res.once('finish', resolve)
            res.once('close', resolve)
            res.json(result)
          })
        return
      }
      const download = await createProjectDownload(files, id, actor, filename, {
        signal: controller.signal,
        limits: downloadLimits,
      })
      await workspaces.terminalRecovery(id, actor, runId)
      if (res.destroyed) return
      res.setHeader('Content-Type', download.type)
      res.setHeader(
        'Content-Disposition',
        downloadDisposition(download.filename),
      )
      await new Promise((resolve) => {
        res.once('finish', resolve)
        res.once('close', resolve)
        res.send(download.content)
      })
    } catch (error) {
      if (
        error.status === 413 &&
        ['DOWNLOAD_ENTRY_LIMIT', 'DOWNLOAD_SCAN_LIMIT'].includes(error.code)
      )
        throw Object.assign(
          new Error(
            'This private copy has too many entries to list or download safely. Ask the server administrator to recover its files.',
          ),
          { status: 413 },
        )
      if (
        !listing &&
        filename === undefined &&
        error.status === 413 &&
        error.code === 'DOWNLOAD_BYTE_LIMIT'
      )
        throw Object.assign(
          new Error(
            'This private copy exceeds the ZIP download limits. Choose individual files to recover smaller files, or ask the server administrator to recover larger files.',
          ),
          { status: 413 },
        )
      throw error
    } finally {
      active.delete(actor)
      res.off('close', close)
    }
  }
  app.get(
    '/api/projects/:id/terminal-recoveries/:runId/files',
    recoverFiles(true),
  )
  app.get(
    '/api/projects/:id/terminal-recoveries/:runId/download',
    recoverFiles(false),
  )
}
