import {
  createProjectDownload,
  downloadDisposition,
} from './project-downloads.mjs'

export function installTerminalRecoveryRoutes(app, workspaces) {
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
  app.get(
    '/api/projects/:id/terminal-recoveries/:runId/download',
    async (req, res) => {
      const { id, runId } = req.params
      const actor = req.user.id
      const recovery = await workspaces.terminalRecovery(id, actor, runId)
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
        const download = await createProjectDownload(
          {
            get: () => recovery,
            readDownloadFile: (_id, _actor, filename, options) =>
              workspaces.readTerminalRecoveryFile(
                id,
                actor,
                runId,
                filename,
                options,
              ),
          },
          id,
          actor,
          undefined,
          { signal: controller.signal },
        )
        if (res.destroyed) return
        res.setHeader('Content-Type', download.type)
        res.setHeader(
          'Content-Disposition',
          downloadDisposition(download.filename),
        )
        res.send(download.content)
      } finally {
        active.delete(actor)
        res.off('close', close)
      }
    },
  )
}
