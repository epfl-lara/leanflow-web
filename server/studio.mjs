import { promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import compression from 'compression'
import { WebSocketServer } from 'ws'
import { Auth, sameOrigin } from './auth.mjs'
import { Runtime } from './runtime.mjs'
import { WorkspaceStore } from './workspaces.mjs'
import { loadConfig } from './config.mjs'
import { EventStore, JobManager } from './events.mjs'
import { AgentManager } from './agents.mjs'
import { Settings } from './settings.mjs'
import { searchDeclarations } from './search.mjs'
import { LspFrames, frame, validateClientUris } from './rpc.mjs'
import { acquireServerLease } from './lease.mjs'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicProject = project => { const { root: _root, ...rest } = project; return rest }
const publicJob = job => { const { snapshot: _snapshot, verificationRoot: _verificationRoot, owner: _owner, ...rest } = job; return rest }

export async function createStudio({ dataDir = process.env.STUDIO_DATA_DIR || path.join(projectDir, '.data'), runtime: suppliedRuntime, config: suppliedConfig } = {}) {
  dataDir = path.resolve(dataDir)
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const auth = new Auth(dataDir); await auth.init()
  const config = suppliedConfig || await loadConfig(dataDir)
  const runtime = suppliedRuntime || new Runtime({ dataDir, scope: 'server', maxConcurrent: Number(process.env.STUDIO_MAX_WORKERS || 6) })
  await runtime.init()
  const workspaces = new WorkspaceStore({ dataDir, runtime }); await workspaces.init()
  const events = new EventStore(dataDir), settings = new Settings(dataDir)
  const agents = new AgentManager({ runtime, workspaces, events, config, settings })
  const jobs = new JobManager({ runtime, workspaces, events })
  const app = express(), server = http.createServer(app), sockets = new Set(), languageServers = new Map()
  const origin = process.env.STUDIO_ORIGIN
  const requireNoRun = (projectId, owner) => {
    if (events.list(owner, projectId).some(job => ['queued', 'running', 'verifying'].includes(job.status))) throw Object.assign(new Error('Stop the current Lemex run before changing the project environment.'), { status: 409 })
  }
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!sameOrigin(req, origin)) return res.status(403).json({ error: 'Request origin is not allowed.' })
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send this request as JSON.' })
    }
    next()
  })
  app.use(express.json({ limit: '3mb' }))
  app.get('/health', (_req, res) => res.json({ ok: true, runtime: runtime.info().ready }))
  app.post('/api/login', async (req, res) => {
    const user = await auth.login(req.body?.token, req.socket.remoteAddress || 'unknown')
    res.setHeader('Set-Cookie', auth.cookie(user, !!origin?.startsWith('https:')))
    res.json({ user: auth.public(user) })
  })
  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'lemex_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    res.json({ ok: true })
  })
  app.use('/api', (req, res, next) => {
    req.user = auth.identify(req)
    if (!req.user) return res.status(401).json({ error: 'Sign in with your collaborator access token.' })
    next()
  })
  app.get('/api/session', (req, res) => res.json({ user: auth.public(req.user), runtime: runtime.info(), models: config.models, defaultModel: config.defaultModel, templates: runtime.templates(), lemex: config.lemex }))
  app.get('/api/settings', async (req, res) => res.json({ ...await settings.get(req.user.id), basePrompt: await fs.readFile(path.join(projectDir, 'prompts/lean-assistant.md'), 'utf8') }))
  app.put('/api/settings', async (req, res) => res.json(await settings.save(req.user.id, req.body)))
  app.get('/api/projects', (req, res) => res.json(workspaces.list(req.user.id).map(publicProject)))
  app.post('/api/projects', async (req, res) => res.status(201).json(publicProject(await workspaces.create(req.user.id, req.body))))
  app.get('/api/projects/:id', (req, res) => res.json(publicProject(workspaces.get(req.params.id, req.user.id))))
  app.post('/api/projects/:id/prepare', async (req, res) => { requireNoRun(req.params.id, req.user.id); res.json(publicProject(await workspaces.prepare(req.params.id, req.user.id))) })
  app.get('/api/projects/:id/files', async (req, res) => res.json(await workspaces.files(req.params.id, req.user.id)))
  app.get('/api/projects/:id/file', async (req, res) => res.json(await workspaces.readFile(req.params.id, req.user.id, req.query.path)))
  app.put('/api/projects/:id/file', async (req, res) => {
    if (['lean-toolchain', 'lakefile.lean', 'lakefile.toml', 'lake-manifest.json'].includes(req.query.path)) requireNoRun(req.params.id, req.user.id)
    res.json(await workspaces.writeFile(req.params.id, req.user.id, req.query.path, req.body.content, req.body.expectedHash))
  })
  app.get('/api/projects/:id/git', async (req, res) => res.json(await workspaces.gitStatus(req.params.id, req.user.id)))
  app.post('/api/projects/:id/git', async (req, res) => {
    const project = workspaces.get(req.params.id, req.user.id)
    if (project.status !== 'ready') throw Object.assign(new Error('Project is not ready.'), { status: 409 })
    const { action, name, message } = req.body
    const options = { network: 'none', timeoutMs: 60_000 }
    const command = async args => {
      const result = await runtime.run(project.root, ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], options)
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Git operation failed.')
      return result
    }
    if (action === 'branch') {
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(name) || name.includes('..') || name.endsWith('.lock')) throw Object.assign(new Error('Enter a valid branch name.'), { status: 400 })
      await command(['switch', '-c', name])
    } else if (action === 'commit') {
      if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw Object.assign(new Error('Enter a commit message.'), { status: 400 })
      const listed = await command(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      const files = []
      for (const filename of listed.stdout.split('\0').filter(Boolean)) {
        if (filename.startsWith('.lake/')) continue
        try { await workspaces.readFile(project.id, req.user.id, filename); files.push(filename) }
        catch (error) { if (error.status === 404) files.push(filename) }
      }
      await new Promise((resolve, reject) => {
        const child = runtime.spawn(project.root, ['git', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], options)
        let output = ''
        child.stdout.on('data', () => {})
        child.stderr.on('data', data => { output += data.toString() })
        child.on('error', reject); child.stdin.on('error', reject)
        child.on('close', code => code === 0 ? resolve() : reject(new Error(output || 'Git staging failed.')))
        child.stdin.end(files.map(filename => filename + '\0').join(''))
      })
      await command(['-c', `user.name=${req.user.name}`, '-c', `user.email=${req.user.id}@lemex-web.local`, 'commit', '-m', message.trim()])
    } else throw Object.assign(new Error('Choose branch or commit.'), { status: 400 })
    res.json(await workspaces.gitStatus(project.id, req.user.id))
  })
  app.post('/api/projects/:id/check', (req, res) => res.status(202).json(publicJob(jobs.check(req.user.id, req.params.id, req.body.path))))
  app.get('/api/jobs/:id', (req, res) => res.json(publicJob(events.get(req.params.id, req.user.id))))
  app.post('/api/projects/:id/runs', (req, res) => res.status(202).json(publicJob(agents.start(req.user.id, req.params.id, req.body))))
  app.get('/api/projects/:id/runs', (req, res) => {
    workspaces.get(req.params.id, req.user.id)
    res.json(events.list(req.user.id, req.params.id).map(publicJob))
  })
  app.get('/api/runs/:id', (req, res) => res.json(publicJob(events.get(req.params.id, req.user.id))))
  app.post('/api/runs/:id/stop', (req, res) => res.json(publicJob(agents.stop(req.user.id, req.params.id))))
  app.post('/api/runs/:id/apply', async (req, res) => res.json(publicJob(await agents.apply(req.user.id, req.params.id))))
  app.get('/api/runs/:id/events', (req, res) => {
    events.get(req.params.id, req.user.id)
    const after = Number(req.headers['last-event-id'] || req.query.after || 0)
    if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: 'Invalid event cursor.' })
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders()
    const send = event => res.write(`id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`)
    const existing = events.events(req.params.id, after)
    for (const event of existing) send(event)
    events.on(req.params.id, send)
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 15_000)
    req.on('close', () => { clearInterval(timer); events.off(req.params.id, send) })
  })
  let searches = 0
  app.post('/api/search', async (req, res) => {
    if (searches >= 4) throw Object.assign(new Error('Search is busy. Try again shortly.'), { status: 429 })
    searches++
    try { res.json(await searchDeclarations(req.body, req.user.id, workspaces)) } finally { searches-- }
  })
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }))
  app.use(compression())
  app.use(express.static(path.join(projectDir, 'client/dist'), { index: 'index.html' }))
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end()
    const message = config.redact(error.message || 'Unexpected server error.')
    res.status(error.status || error.statusCode || 500).json({ error: message })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    const user = auth.identify(req)
    const match = /^\/websocket\/([a-zA-Z0-9_-]+)$/.exec(req.url || '')
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`) }
    if (!user) return reject('401 Unauthorized')
    if (!sameOrigin(req, origin)) return reject('403 Forbidden')
    if (!match) return reject('404 Not Found')
    let project
    try { project = workspaces.get(match[1], user.id) } catch { return reject('404 Not Found') }
    if (project.status !== 'ready') return reject('409 Conflict')
    if (sockets.size >= 4 || (languageServers.get(project.id) || 0) >= 2) return reject('429 Too Many Requests')
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, project))
  })
  wss.on('connection', (ws, _req, project) => {
    sockets.add(ws); languageServers.set(project.id, (languageServers.get(project.id) || 0) + 1)
    let child, alive = true, lastActivity = Date.now()
    const pending = new Map()
    try {
      child = runtime.spawn(project.root, ['lake', 'serve', '--'], { network: 'none' })
      const frames = new LspFrames(message => {
        const method = pending.get(message.id)
        if ('id' in message && !message.method) pending.delete(message.id)
        if (method === 'textDocument/completion' && message.result?.items?.length > 300) { message.result.items = message.result.items.slice(0, 300); message.result.isIncomplete = true }
        if (ws.readyState === 1) ws.send(JSON.stringify(message))
      })
      child.stdout.on('data', chunk => { try { frames.push(chunk) } catch { ws.close(1011, 'Lean returned an invalid message.'); child.kill() } })
      child.stderr.on('data', chunk => console.error(`[Lean ${project.id}] ${config.redact(chunk.toString()).slice(0, 2000)}`))
      child.on('error', () => ws.close(1011, 'Lean could not start.'))
      child.on('close', () => ws.close(1011, 'Lean stopped. Reopen the project to reconnect.'))
      child.stdin.on('error', () => ws.close(1011, 'Lean connection closed.'))
      ws.on('message', data => {
        lastActivity = Date.now()
        try {
          const message = validateClientUris(JSON.parse(data.toString()))
          if (message.method && 'id' in message) pending.set(message.id, message.method)
          if (pending.size > 1000) throw new Error('Too many outstanding Lean requests.')
          child.stdin.write(frame(message))
        } catch { ws.close(1008, 'Invalid Lean message or workspace path.') }
      })
    } catch (error) { ws.close(1013, config.redact(error.message).slice(0, 100)) }
    ws.on('pong', () => { alive = true })
    const heartbeat = setInterval(() => {
      if (!alive || Date.now() - lastActivity > 30 * 60_000) return ws.terminate()
      alive = false; ws.ping()
    }, 30_000)
    ws.on('close', () => { clearInterval(heartbeat); child?.kill(); sockets.delete(ws); languageServers.set(project.id, Math.max(0, (languageServers.get(project.id) || 1) - 1)) })
    ws.on('error', () => child?.kill())
  })
  let closePromise
  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      const stopped = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      for (const ws of sockets) ws.terminate()
      const checksStopped = jobs.shutdown(), agentsStopped = agents.shutdown()
      await runtime.shutdown?.()
      await Promise.allSettled([checksStopped, agentsStopped, ...workspaces.jobs.values()])
      await stopped
      workspaces.close(); events.close()
    })()
    return closePromise
  }
  return { app, server, auth, runtime, workspaces, events, agents, config, settings, close }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || path.join(projectDir, '.data'))
  const { release } = await acquireServerLease(dataDir)
  let studio
  try { studio = await createStudio({ dataDir }) } catch (error) { await release(); throw error }
  const port = Number(process.env.PORT || 8090), host = process.env.HOST || '127.0.0.1'
  studio.server.listen(port, host, () => console.log(`Lemex Web: http://${host}:${port}\nAccess token: ${path.join(process.env.STUDIO_DATA_DIR || path.join(projectDir, '.data'), 'auth/owner.token')}\nLemex revision: ${studio.config.lemex.revision || 'unknown'}`))
  studio.server.on('error', error => { console.error(error.message); studio.close().finally(release).finally(() => process.exit(1)) })
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => studio.close().then(release).then(() => process.exit(0)))
}
