import { promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import compression from 'compression'
import { WebSocketServer } from 'ws'
import { Auth, sameOrigin } from './auth.mjs'
import { authRequestJson, isPublicAuthRequest } from './auth-request-limits.mjs'
import { Runtime } from './runtime.mjs'
import { Terminals } from './terminals.mjs'
import { WorkspaceStore, validateRepository } from './workspaces.mjs'
import { GitConnections } from './git-connections.mjs'
import { loadConfig } from './config.mjs'
import { EventStore, JobManager } from './events.mjs'
import { TexBuildManager } from './tex-builds.mjs'
import { AgentManager } from './agents.mjs'
import { Settings } from './settings.mjs'
import { Providers } from './providers.mjs'
import { ModelDiscovery } from './model-discovery.mjs'
import { ModelPreferences } from './model-preferences.mjs'
import { ChatStore } from './chats.mjs'
import { TrashManager } from './trash.mjs'
import { createChatTitleGenerator } from './chat-titles.mjs'
import { searchDeclarations } from './search.mjs'
import { LspFrames, frame, validateClientUris } from './rpc.mjs'
import { LeanRequests } from './lean-requests.mjs'
import { LeanProgress } from './lean-progress.mjs'
import { LeanEditPolicy } from './lean-edit-policy.mjs'
import { LeanWidgetPolicy } from './lean-widget-policy.mjs'
import { ProjectActivity } from './project-activity.mjs'
import { acquireServerLease } from './lease.mjs'
import { repairProjectSetup, withSetupRepairDeadline } from './setup-repair.mjs'
import { GitPublisher } from './git-publish.mjs'
import { validateGitBranch } from './git-branches.mjs'
import { pdfDisposition } from './pdf-preview.mjs'
import { installProjectDownloadRoutes } from './project-downloads.mjs'
import { proofTargetReference } from './proof-target.mjs'
import { loadCapacity } from './capacity.mjs'
import { LeanBooks, installBookRoutes } from './lean-books.mjs'
import {
  sourceBodyKind,
  isSmallSourceBody,
  sourceRequestAdmission,
  sourceRequestHandler,
  finishSourceRequest,
} from './source-request-admission.mjs'
import {
  MAX_SOURCE_JSON_BYTES,
  SMALL_SOURCE_JSON_BYTES,
  MAX_UPLOAD_JSON_BYTES,
} from '../shared/source-limits.mjs'

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const publicProject = (project) => {
  const { root: _root, ...rest } = project
  return rest
}
const publicJob = (job) => {
  const {
    snapshot: _snapshot,
    verificationRoot: _verificationRoot,
    followupContexts: _followupContexts,
    owner: _owner,
    ...rest
  } = job
  return rest
}
const publicRunReceipt = (job) => {
  const { changes, liveChanges, ...rest } = publicJob(job)
  return {
    ...rest,
    changeCount: changes?.length || 0,
    liveChangeCount: liveChanges?.length || 0,
    changePaths: (changes || []).map((change) => change.path),
    liveChangePaths: (liveChanges || []).map((change) => change.path),
    ...(job.proofTarget
      ? { proofTarget: proofTargetReference(job.proofTarget) }
      : {}),
  }
}
const runMetadata = (job) => {
  const fields = [
    'id',
    'kind',
    'projectId',
    'chatId',
    'file',
    'currentFile',
    'files',
    'mode',
    'model',
    'effort',
    'status',
    'createdAt',
    'updatedAt',
    'maxSeconds',
    'liveEdits',
    'liveRevision',
    'liveUndone',
    'progress',
  ]
  const result = Object.fromEntries(
    fields
      .filter((key) => job[key] !== undefined)
      .map((key) => [key, job[key]]),
  )
  if (job.proofTarget)
    result.proofTarget = proofTargetReference(job.proofTarget)
  if (Array.isArray(job.liveChanges))
    result.liveChangePaths = job.liveChanges.map((change) => change.path)
  if (Array.isArray(job.changes))
    result.changePaths = job.changes.map((change) => change.path)
  return result
}
const chatTranscript = (job, eventCursor, reasoningBlocks) => ({
  ...runMetadata(job),
  prompt: job.prompt || '',
  message: job.message || '',
  messageBaseOffset: job.messageBaseOffset || 0,
  messageTruncated: !!job.messageTruncated,
  reasoningBlocks,
  reasoningHistoryAvailable: true,
  followups: (job.followups || []).map((entry) => ({
    ...entry,
    ...(entry.proofTarget
      ? { proofTarget: proofTargetReference(entry.proofTarget) }
      : {}),
  })),
  changeCount: job.changes?.length || 0,
  liveChangeCount: job.liveChanges?.length || 0,
  reasoningChars: job.reasoning?.length || 0,
  reasoningSummaryChars: job.reasoningSummary?.length || 0,
  logChars: job.log?.length || 0,
  eventCursor,
  ...(job.usage ? { usage: job.usage } : {}),
  ...(job.verification
    ? {
        verification: Object.fromEntries(
          ['kind', 'compiled', 'complete', 'kernelChecked', 'reason']
            .filter((key) => job.verification[key] !== undefined)
            .map((key) => [key, job.verification[key]]),
        ),
      }
    : {}),
  ...(job.error ? { error: job.error } : {}),
})

export async function createStudio({
  dataDir = process.env.STUDIO_DATA_DIR || path.join(projectDir, '.data'),
  runtime: suppliedRuntime,
  config: suppliedConfig,
  gitConnections: suppliedGitConnections,
  titleGenerator: suppliedTitleGenerator,
  capacity = loadCapacity(),
  books = new LeanBooks(),
  modelDiscoverer,
} = {}) {
  dataDir = path.resolve(dataDir)
  const workspaceDataDir = dataDir
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  dataDir = await fs.realpath(dataDir)
  const auth = new Auth(dataDir)
  await auth.init()
  const config = suppliedConfig || (await loadConfig(dataDir))
  const providers = await new Providers(
    dataDir,
    auth.key,
    config.provider?.LEMEX_BASE_URL,
    config.redact,
  ).init()
  config.redact = providers.redact
  config.providerForUser = (owner) => providers.provider(owner)
  const modelDiscovery = new ModelDiscovery({
    dataDir,
    config,
    providers,
    ...(modelDiscoverer ? { discover: modelDiscoverer } : {}),
  })
  config.modelsForUser = (owner, options) => modelDiscovery.get(owner, options)
  const modelPreferences = new ModelPreferences(dataDir)
  const runtime =
    suppliedRuntime ||
    new Runtime({
      dataDir,
      scope: 'server',
      maxConcurrent: capacity.workers,
      maxQueue: capacity.workerQueue,
      cpus: capacity.workerCpus,
      memory: capacity.workerMemory,
      kernelExportMaxBytes: capacity.kernelExportMaxBytes,
    })
  await runtime.init()
  let playgroundPreparation = Promise.resolve()
  const preparePlayground = () => {
    if (runtime.preparePresetEnvironment && runtime.templateRoot('mathlib'))
      playgroundPreparation = runtime
        .preparePresetEnvironment('mathlib')
        .catch((error) => {
          console.warn(
            'Mathlib Playground preparation failed:',
            config.redact(error.message),
          )
        })
  }
  const playgroundState = () => ({
    state:
      runtime.templates().find((preset) => preset.id === 'mathlib')
        ?.playgroundState || 'unavailable',
  })
  preparePlayground()
  const gitConnections =
    suppliedGitConnections ||
    (await new GitConnections({ dataDir, validateRepository }).init())
  const gitIdentity = async (owner) => {
    const { identity } = await gitConnections.get(owner)
    return {
      name:
        identity.name ||
        auth.users.find((user) => user.id === owner)?.name ||
        owner,
      email: identity.email || `${owner}@lemex-web.local`,
    }
  }
  const workspaces = new WorkspaceStore({
    dataDir: workspaceDataDir,
    runtime,
    setupBuildTimeoutMs: capacity.setupBuildTimeoutMs,
    gitCredentials: (owner, repository) =>
      gitConnections.credentials(owner, repository),
  })
  await workspaces.init()
  const events = new EventStore(dataDir),
    settings = new Settings(dataDir)
  const chats = new ChatStore({
    dataDir,
    workspaces,
    events,
    redact: config.redact,
    titleGenerator: suppliedTitleGenerator || createChatTitleGenerator(config),
  })
  await chats.init()
  const texBuilds = new TexBuildManager({
    dataDir,
    events,
    runtime,
    workspaces,
    assertCanStart: (owner, projectId) => requireNoGit(projectId, owner),
  })
  await texBuilds.init()
  const agents = new AgentManager({
    texBuilds,
    runtime,
    workspaces,
    events,
    config,
    settings,
    chats,
    books,
    assertCanStart: (owner, projectId) => requireNoGit(projectId, owner),
    maxConcurrent: capacity.agents,
    maxQueue: capacity.agentQueue,
  })
  workspaces.setupRepair = (args) =>
    withSetupRepairDeadline(
      (boundedSignal) =>
        agents.runSetupRepair(
          (signal) => repairProjectSetup({ runtime, config, ...args, signal }),
          {
            signal: boundedSignal,
            onQueued: () => args.onProgress?.('waiting-for-repair'),
            onStarted: () => args.onProgress?.('repairing-setup'),
          },
        ),
      { signal: args.signal, timeoutMs: capacity.setupRepairTimeoutMs },
    )
  const jobs = new JobManager({
    runtime,
    workspaces,
    events,
    checkTimeoutMs: capacity.checkTimeoutMs,
  })
  const activity = new ProjectActivity({
    texBuilds,
    events,
    jobs,
    agents,
    workspaces,
    runtime,
  })
  const app = express(),
    server = http.createServer(app),
    sockets = new Set(),
    languageServers = new Map(),
    socketProjects = new Map()
  const closeProjectEditors = (projectId) => {
    for (const ws of sockets)
      if (socketProjects.get(ws) === projectId)
        ws.close(1012, 'Project configuration changed. Retry setup.')
  }
  const origin = process.env.STUDIO_ORIGIN
  const terminals = new Terminals({
    runtime,
    capacity,
    workspaces,
    gitConnections,
    gitIdentity,
    redact: config.redact,
  })
  let publisher
  const requireNoGit = (
    projectId,
    owner,
    { includeArchived = false, ignoreStopping = false } = {},
  ) => {
    if (includeArchived) {
      if (
        !workspaces.db
          .prepare('SELECT 1 FROM projects WHERE id=? AND owner=?')
          .get(projectId, owner)
      )
        throw Object.assign(new Error('Project not found.'), { status: 404 })
    } else workspaces.get(projectId, owner)
    if (!ignoreStopping) activity.assertCanStart(owner, projectId)
    if (publisher?.busy.has(projectId))
      throw Object.assign(
        new Error(
          'Wait for the current Git operation before starting other project work.',
        ),
        { status: 409 },
      )
  }
  const requireNoRun = (projectId, owner, { ignoreGit = false } = {}) => {
    if (!ignoreGit) requireNoGit(projectId, owner)
    else activity.assertCanStart(owner, projectId)
    terminals.assertIdle(projectId)
    if (
      events.db
        .prepare(
          "SELECT 1 FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND (json_extract(payload,'$.status') IN ('queued','starting','running','stopping','verifying','preparing') OR json_extract(payload,'$.cleanupFailed')=1) LIMIT 1",
        )
        .get(owner, projectId)
    )
      throw Object.assign(
        new Error(
          'Stop active Lean checks, TeX builds, and Lemex runs before changing the project environment.',
        ),
        { status: 409 },
      )
  }
  const requireNoActiveWork = (
    projectId,
    owner,
    { ignoreStopping = false } = {},
  ) => {
    requireNoGit(projectId, owner, { includeArchived: true, ignoreStopping })
    terminals.assertIdle(projectId)
    const active = events.db
      .prepare(
        "SELECT 1 FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND (json_extract(payload,'$.status') IN ('queued','starting','running','stopping','verifying','preparing') OR json_extract(payload,'$.cleanupFailed')=1) LIMIT 1",
      )
      .get(owner, projectId)
    if (active || workspaces.jobs.has(projectId))
      throw Object.assign(
        new Error(
          'Stop active Lean checks, TeX builds, and Lemex runs, and wait for project preparation, before deleting or restoring project data.',
        ),
        { status: 409 },
      )
  }
  const trash = new TrashManager({
    texBuilds,
    workspaces,
    chats,
    events,
    assertIdle: requireNoActiveWork,
    redact: config.redact,
  })
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!sameOrigin(req, origin))
        return res.status(403).json({
          error: origin
            ? 'This address is not enabled for sign-in or changes. Open the configured workspace address.'
            : 'This address is not enabled for sign-in or changes. Ask the server administrator to configure the public HTTPS address (STUDIO_ORIGIN).',
        })
      if (!req.is('application/json'))
        return res.status(415).json({ error: 'Send this request as JSON.' })
    }
    next()
  })
  // Public account requests have their own small, bounded parser.
  app.use(authRequestJson())
  // Protected requests authenticate before allocating a source/upload body.
  app.use('/api', (req, res, next) => {
    if (isPublicAuthRequest(req)) return next()
    req.user = auth.identify(req)
    if (!req.user)
      return res
        .status(401)
        .json({ error: 'Sign in with your collaborator access token.' })
    next()
  })
  const ordinaryJson = express.json({ limit: SMALL_SOURCE_JSON_BYTES }),
    sourceJson = express.json({ limit: MAX_SOURCE_JSON_BYTES }),
    uploadJson = express.json({ limit: MAX_UPLOAD_JSON_BYTES })
  app.use(
    sourceRequestAdmission({
      bulk: capacity.sourceRequests ?? 2,
      bulkPerUser: capacity.sourceRequestsPerUser ?? 1,
      small: capacity.smallSourceRequests ?? 8,
      smallPerUser: capacity.smallSourceRequestsPerUser ?? 2,
    }),
  )
  app.use((req, res, next) => {
    if (isPublicAuthRequest(req)) return next()
    const kind = sourceBodyKind(req)
    const parser =
      !kind || isSmallSourceBody(req)
        ? ordinaryJson
        : kind === 'upload' || kind === 'batch'
          ? uploadJson
          : sourceJson
    parser(req, res, next)
  })
  app.get('/health', (_req, res) =>
    res.json({ ok: true, runtime: runtime.info().ready }),
  )
  app.post('/api/login', async (req, res) => {
    const user = await auth.login(
      req.body?.token,
      req.socket.remoteAddress || 'unknown',
    )
    // Recovery preserves unsaved buffers belonging to the current account.
    // Check the authenticated identity before replacing the browser cookie.
    if (
      req.body?.expectedUserId !== undefined &&
      req.body.expectedUserId !== user.id
    )
      return res.status(409).json({
        error:
          'This token belongs to a different account. Use the access token for the workspace you have open.',
      })
    if (req.body.apiKey !== undefined) {
      const base = providers.selection(user.id, req.body)
      const key = await providers.validate(req.body.apiKey, undefined, base)
      await providers.save(user.id, key, base)
    }
    res.setHeader(
      'Set-Cookie',
      auth.cookie(user, !!origin?.startsWith('https:')),
    )
    res.json({ user: auth.public(user) })
  })
  app.post('/api/logout', (_req, res) => {
    res.setHeader(
      'Set-Cookie',
      'lemex_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    )
    res.json({ ok: true })
  })
  app.get('/api/session', async (req, res) => {
    let modelAccess
    try {
      modelAccess = await modelDiscovery.get(req.user.id)
    } catch (error) {
      modelAccess = {
        models: [],
        defaultModel: null,
        modelError: config.redact(error.message),
      }
    }
    res.json({
      user: auth.public(req.user),
      eventTransport:
        process.env.STUDIO_EVENT_TRANSPORT === 'poll' ? 'poll' : 'sse',
      capacity,
      runtime: runtime.info(),
      models: modelAccess.models,
      savedModels: await modelPreferences.get(req.user.id, modelAccess),
      defaultModel: modelAccess.defaultModel,
      modelsUpdatedAt: modelAccess.modelsUpdatedAt || null,
      templates: runtime.templates(),
      lemex: {
        ...config.lemex,
        ...providers.status(req.user.id),
        modelError: modelAccess.modelError || null,
      },
    })
  })
  const publicModels = async (owner, access) => ({
    models: access.models,
    defaultModel: access.defaultModel,
    modelsUpdatedAt: access.modelsUpdatedAt,
    savedModels: await modelPreferences.get(owner, access),
    providerId: access.providerId,
    isRcp: access.isRcp,
  })
  app.get('/api/models', async (req, res) =>
    res.json(
      await publicModels(req.user.id, await modelDiscovery.get(req.user.id)),
    ),
  )
  app.post('/api/models/refresh', async (req, res) =>
    res.json(
      await publicModels(
        req.user.id,
        await modelDiscovery.get(req.user.id, { refresh: true }),
      ),
    ),
  )
  app.put('/api/models/preferences', async (req, res) => {
    const access = await modelDiscovery.get(req.user.id)
    await modelPreferences.save(req.user.id, req.body?.savedModels, access)
    res.json(await publicModels(req.user.id, access))
  })
  app.get('/api/provider', (req, res) =>
    res.json(providers.status(req.user.id)),
  )
  app.put('/api/provider', async (req, res) => {
    const base = providers.selection(req.user.id, req.body)
    const key = await providers.validate(req.body?.apiKey, undefined, base)
    res.json(await providers.save(req.user.id, key, base))
  })
  app.get('/api/admin/users', async (req, res) => {
    auth.requireAdmin(req.user)
    await auth.refreshUsers()
    res.json(
      auth.users.map((user) => ({
        ...auth.public(user),
        lemex: providers.status(user.id),
      })),
    )
  })
  app.post('/api/admin/users', async (req, res) => {
    res.status(201).json(await auth.createUser(req.user, req.body))
  })
  app.get('/api/playground', (_req, res) => res.json(playgroundState()))
  app.post('/api/playground/prepare', (_req, res) => {
    preparePlayground()
    res.status(202).json(playgroundState())
  })
  app.get('/api/settings', async (req, res) =>
    res.json({
      ...(await settings.get(req.user.id)),
      basePrompt: await fs.readFile(
        path.join(projectDir, 'prompts/lean-assistant.md'),
        'utf8',
      ),
    }),
  )
  app.put('/api/settings', async (req, res) =>
    res.json(await settings.save(req.user.id, req.body)),
  )
  app.get('/api/projects', (req, res) =>
    res.json(workspaces.list(req.user.id).map(publicProject)),
  )
  app.get('/api/git-connections', async (req, res) =>
    res.json(await gitConnections.get(req.user.id)),
  )
  app.put('/api/git-connections', async (req, res) => {
    const input = req.body
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Object.assign(
        new Error('Choose a Git connection or commit identity to save.'),
        { status: 400 },
      )
    if (input.action === 'connect')
      return res.json(await gitConnections.connect(req.user.id, input))
    if (input.action === 'identity')
      return res.json(await gitConnections.setIdentity(req.user.id, input))
    throw Object.assign(
      new Error('Choose a Git connection or commit identity to save.'),
      { status: 400 },
    )
  })
  app.delete('/api/git-connections', async (req, res) =>
    res.json(await gitConnections.disconnect(req.user.id, req.query.host)),
  )
  app.post(
    '/api/projects',
    sourceRequestHandler(async (req, res) =>
      res
        .status(201)
        .json(publicProject(await workspaces.create(req.user.id, req.body))),
    ),
  )
  app.get('/api/projects/:id', (req, res) =>
    res.json(publicProject(workspaces.get(req.params.id, req.user.id))),
  )
  app.post('/api/projects/:id/terminal/stop', async (req, res) => {
    workspaces.get(req.params.id, req.user.id)
    await terminals.closeProject(req.params.id)
    res.json({ stopped: true })
  })
  app.post('/api/projects/:id/convert', async (req, res) =>
    res.json(
      publicProject(
        await workspaces.convertSingleFile(req.params.id, req.user.id),
      ),
    ),
  )
  app.post('/api/projects/:id/rename', async (req, res) =>
    res.json(
      publicProject(
        await workspaces.rename(req.params.id, req.user.id, req.body),
      ),
    ),
  )
  app.post('/api/projects/:id/prepare', async (req, res) => {
    requireNoRun(req.params.id, req.user.id)
    res.json(
      publicProject(
        await workspaces.prepare(req.params.id, req.user.id, {
          assertIdle: () => requireNoRun(req.params.id, req.user.id),
          repositoryToken: req.body?.repositoryToken,
          repositoryUsername: req.body?.repositoryUsername,
        }),
      ),
    )
  })
  app.post('/api/projects/:id/prepare/stop', async (req, res) =>
    res.json(
      publicProject(
        await workspaces.stopPreparation(req.params.id, req.user.id),
      ),
    ),
  )
  app.post(
    '/api/projects/:id/upload',
    sourceRequestHandler(async (req, res) => {
      requireNoActiveWork(req.params.id, req.user.id)
      const result = await workspaces.upload(
        req.params.id,
        req.user.id,
        req.body.files,
      )
      if (result.requiresPreparation) closeProjectEditors(req.params.id)
      res.json(result)
    }),
  )
  app.get('/api/projects/:id/files', async (req, res) =>
    res.json(await workspaces.files(req.params.id, req.user.id)),
  )
  app.put(
    '/api/projects/:id/files',
    sourceRequestHandler(async (req, res) => {
      const saved = await workspaces.writeFiles(
        req.params.id,
        req.user.id,
        req.body?.files,
        {
          assertConfigurationIdle: () =>
            requireNoRun(req.params.id, req.user.id),
        },
      )
      if (saved.requiresPreparation) closeProjectEditors(req.params.id)
      res.json(saved)
    }),
  )
  app.get('/api/projects/:id/folders', async (req, res) =>
    res.json(await workspaces.folders(req.params.id, req.user.id)),
  )
  app.post(
    '/api/projects/:id/folders',
    sourceRequestHandler(async (req, res) =>
      res
        .status(201)
        .json(
          await workspaces.createFolder(req.params.id, req.user.id, req.body),
        ),
    ),
  )
  app.get('/api/projects/:id/file', async (req, res) =>
    res.json(
      await workspaces.readFile(req.params.id, req.user.id, req.query.path),
    ),
  )
  installProjectDownloadRoutes(app, workspaces)
  app.get('/api/projects/:id/file-preview', async (req, res) => {
    const preview = await workspaces.readPdfPreview(
      req.params.id,
      req.user.id,
      req.query.path,
    )
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', pdfDisposition(preview.path))
    res.send(preview.content)
  })
  app.post('/api/projects/:id/library-source', async (req, res) =>
    res.json(
      await workspaces.readLibrarySource(req.params.id, req.user.id, req.body),
    ),
  )
  app.put(
    '/api/projects/:id/file',
    sourceRequestHandler(async (req, res) => {
      if (
        [
          'lean-toolchain',
          'lakefile.lean',
          'lakefile.toml',
          'lake-manifest.json',
        ].includes(req.query.path)
      )
        requireNoRun(req.params.id, req.user.id)
      const saved = await workspaces.writeFile(
        req.params.id,
        req.user.id,
        req.query.path,
        req.body.content,
        req.body.expectedHash,
      )
      if (saved.requiresPreparation) closeProjectEditors(req.params.id)
      res.json(saved)
    }),
  )
  app.post('/api/projects/:id/trash', async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      (req.body.path !== undefined && typeof req.body.path !== 'string') ||
      (req.body.stopActive !== undefined &&
        typeof req.body.stopActive !== 'boolean')
    )
      throw Object.assign(
        new Error(
          'Choose a file or folder path, or omit path to archive the project. stopActive must be true or false.',
        ),
        { status: 400 },
      )
    workspaces.get(req.params.id, req.user.id)
    requireNoGit(req.params.id, req.user.id)
    const move = async (ignoreStopping = false) => {
      const assertIdle = () =>
        requireNoActiveWork(req.params.id, req.user.id, { ignoreStopping })
      assertIdle()
      return workspaces.trash(req.params.id, req.user.id, req.body.path, {
        assertIdle,
        candidateRunIds:
          req.body.path === undefined
            ? events
                .projectMetadata(req.user.id, req.params.id)
                .map((job) => job.id)
            : [],
      })
    }
    const receipt = req.body.stopActive
      ? await activity.withStopped(req.user.id, req.params.id, async () => {
          await terminals.closeProject(req.params.id)
          for (const ws of sockets)
            if (socketProjects.get(ws) === req.params.id)
              ws.close(1001, 'Project processes stopped for Trash.')
          return move(true)
        })
      : await move()
    if (receipt.kind === 'project')
      for (const ws of sockets)
        if (socketProjects.get(ws) === receipt.projectId)
          ws.close(1001, 'Project archived.')
    if (
      receipt.kind !== 'project' &&
      workspaces.get(receipt.projectId, req.user.id).needsPreparation
    )
      closeProjectEditors(receipt.projectId)
    res.json(receipt)
  })
  app.get('/api/trash', async (req, res) =>
    res.json(
      [
        ...(await workspaces.listTrashWithSizes(req.user.id, {
          projectRunIds: (id) =>
            events.projectMetadata(req.user.id, id).map((job) => job.id),
        })),
        ...chats.listTrash(req.user.id),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ),
  )
  app.post('/api/trash/delete-all', async (req, res) =>
    res.json(await trash.deleteAll(req.user.id, req.body)),
  )
  app.post('/api/trash/:id/delete-forever', async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length
    )
      throw Object.assign(
        new Error('Send an empty object to delete this item forever.'),
        {
          status: 400,
        },
      )
    res.json(await trash.deleteForever(req.user.id, req.params.id))
  })
  app.post('/api/trash/:id/restore', async (req, res) => {
    let entry
    try {
      entry = workspaces.getTrash(req.params.id, req.user.id)
    } catch (error) {
      if (error.status !== 404) throw error
      return res.json(chats.restore(req.user.id, req.params.id))
    }
    const assertIdle = () => requireNoActiveWork(entry.projectId, req.user.id)
    assertIdle()
    const result = await workspaces.restore(req.params.id, req.user.id, {
      assertIdle,
    })
    if (workspaces.get(entry.projectId, req.user.id).needsPreparation)
      closeProjectEditors(entry.projectId)
    res.json(result)
  })
  publisher = await new GitPublisher({
    dataDir,
    runtime,
    workspaces,
    assertIdle: (id, owner) => requireNoRun(id, owner, { ignoreGit: true }),
    redact: config.redact,
    gitCredentials: (owner, repository) =>
      gitConnections.credentials(owner, repository),
  }).init()
  const gitInfo = async (id, user) => ({
    ...(await publisher.metadata(user.id, id)),
    author: await gitIdentity(user.id),
  })
  app.get('/api/projects/:id/git', async (req, res) => {
    workspaces.get(req.params.id, req.user.id)
    activity.assertCanStart(req.user.id, req.params.id)
    res.json(await gitInfo(req.params.id, req.user))
  })
  app.post('/api/projects/:id/git', async (req, res) => {
    const { action, name, message, authorName, authorEmail, reviewToken } =
      req.body
    if (action === 'preview-push')
      return res.json(
        await publisher.preview(req.user.id, req.params.id, req.body),
      )
    if (action === 'push')
      return res.json(
        await publisher.push(req.user.id, req.params.id, req.body),
      )
    if (action === 'enable-publishing') {
      await workspaces.enablePublishing(req.params.id, req.user.id, {
        assertIdle: () => requireNoRun(req.params.id, req.user.id),
      })
      return res.json(await gitInfo(req.params.id, req.user))
    }
    await publisher.withProject(req.user.id, req.params.id, async (project) => {
      const options = { network: 'none', timeoutMs: 60_000 }
      const gitRoot = workspaces.repositoryRoot(project)
      const command = async (args) => {
        const result = await runtime.run(
          gitRoot,
          [
            'git',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'credential.helper=',
            ...args,
          ],
          options,
        )
        if (result.code !== 0)
          throw new Error(
            result.stderr || result.stdout || 'Git operation failed.',
          )
        return result
      }
      if (action === 'branch') {
        await command(['switch', '-c', validateGitBranch(name)])
      } else if (action === 'commit') {
        if (
          typeof message !== 'string' ||
          !message.trim() ||
          message.length > 2000
        )
          throw Object.assign(new Error('Enter a commit message.'), {
            status: 400,
          })
        const listed = await command([
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
        ])
        const files = []
        const prefix = project.subdirectory ? project.subdirectory + '/' : ''
        for (const filename of listed.stdout.split('\0').filter(Boolean)) {
          if (prefix && !filename.startsWith(prefix)) continue
          const relative = filename.slice(prefix.length)
          if (relative.startsWith('.lake/')) continue
          try {
            await workspaces.gitFilePath(project.id, req.user.id, relative)
            files.push(filename)
          } catch (error) {
            if (error.status === 404) files.push(filename)
          }
        }
        if (!files.length)
          throw Object.assign(
            new Error('There are no project files to commit.'),
            { status: 409 },
          )
        if (reviewToken !== undefined) {
          if (
            typeof reviewToken !== 'string' ||
            !/^[a-f0-9]{64}$/.test(reviewToken) ||
            (await publisher.metadata(req.user.id, project.id)).reviewToken !==
              reviewToken
          )
            throw Object.assign(
              new Error(
                'Project files or Git history changed after this review. Refresh and review the current changes before committing.',
              ),
              { status: 409 },
            )
        }
        if (
          authorName !== undefined &&
          (typeof authorName !== 'string' ||
            !authorName.trim() ||
            authorName.length > 200 ||
            /[<>\x00-\x1f]/.test(authorName))
        )
          throw Object.assign(new Error('Enter a valid commit author name.'), {
            status: 400,
          })
        if (
          authorEmail !== undefined &&
          (typeof authorEmail !== 'string' ||
            authorEmail.length > 254 ||
            !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(
              authorEmail,
            ))
        )
          throw Object.assign(new Error('Enter a valid commit author email.'), {
            status: 400,
          })
        const withPaths = (args) =>
          new Promise((resolve, reject) => {
            const child = runtime.spawn(
              gitRoot,
              [
                'git',
                '--literal-pathspecs',
                '-c',
                'core.hooksPath=/dev/null',
                ...args,
                '--pathspec-from-file=-',
                '--pathspec-file-nul',
              ],
              options,
            )
            let output = ''
            child.stdout.on('data', () => {})
            child.stderr.on('data', (data) => {
              output += data.toString()
            })
            child.on('error', reject)
            child.stdin.on('error', reject)
            child.on('close', (code) =>
              code === 0
                ? resolve()
                : reject(new Error(output || 'Git operation failed.')),
            )
            child.stdin.end(files.map((filename) => filename + '\0').join(''))
          })
        await withPaths(['add', '-A'])
        const identity = await gitIdentity(req.user.id)
        // A checkout may already have staged sibling or private files. Commit only
        // the admitted project paths, leaving unrelated staged work untouched.
        await withPaths([
          '-c',
          `user.name=${authorName?.trim() || identity.name}`,
          '-c',
          `user.email=${authorEmail || identity.email}`,
          'commit',
          '--only',
          '-m',
          message.trim(),
        ])
      } else
        throw Object.assign(new Error('Choose branch or commit.'), {
          status: 400,
        })
    })
    res.json(await gitInfo(req.params.id, req.user))
  })
  app.get('/api/projects/:id/tex', async (req, res) =>
    res.json(
      await texBuilds.state(req.user.id, req.params.id, {
        rootFile: req.query.rootFile,
      }),
    ),
  )
  app.post('/api/projects/:id/tex/build', async (req, res) => {
    requireNoGit(req.params.id, req.user.id)
    res
      .status(202)
      .json(await texBuilds.start(req.user.id, req.params.id, req.body))
  })
  const projectTexBuild = (req) => {
    const job = texBuilds.get(req.user.id, req.params.buildId)
    if (job.projectId !== req.params.id)
      throw Object.assign(new Error('TeX build not found.'), { status: 404 })
    return job
  }
  app.get('/api/projects/:id/tex/builds/:buildId', (req, res) =>
    res.json(projectTexBuild(req)),
  )
  app.post('/api/projects/:id/tex/builds/:buildId/stop', async (req, res) => {
    projectTexBuild(req)
    res.json(await texBuilds.stop(req.user.id, req.params.buildId))
  })
  app.get('/api/projects/:id/tex/builds/:buildId/pdf', async (req, res) => {
    projectTexBuild(req)
    const preview = await texBuilds.readPdf(req.user.id, req.params.buildId)
    res.type('application/pdf')
    res.setHeader('Content-Disposition', pdfDisposition(preview.path))
    res.send(preview.content)
  })
  app.post('/api/projects/:id/check', (req, res) => {
    requireNoGit(req.params.id, req.user.id)
    const job = jobs.check(req.user.id, req.params.id, req.body.path)
    res.status(202).json(publicJob(events.snapshot(job.id, req.user.id)))
  })
  app.get('/api/projects/:id/checks', (req, res) => {
    workspaces.get(req.params.id, req.user.id)
    res.json(
      events
        .activeMetadata(req.user.id, req.params.id, 'check')
        .map((job) => publicJob(events.snapshot(job.id, req.user.id))),
    )
  })
  app.get('/api/jobs/:id', (req, res) =>
    res.json(publicJob(events.snapshot(req.params.id, req.user.id))),
  )
  app.post('/api/jobs/:id/stop', async (req, res) => {
    await jobs.stop(req.user.id, req.params.id)
    res.json(publicJob(events.snapshot(req.params.id, req.user.id)))
  })
  app.get('/api/projects/:id/chats', (req, res) =>
    res.json(chats.list(req.user.id, req.params.id)),
  )
  app.post('/api/projects/:id/chats', (req, res) =>
    res.status(201).json(chats.create(req.user.id, req.params.id, req.body)),
  )
  app.get('/api/chats/:id', (req, res) => {
    const { chat, runs } = chats.history(req.params.id, req.user.id)
    res.json({
      chat,
      runs: runs.map((job) =>
        chatTranscript(job, events.cursor(job.id), events.reasoningBlocks(job)),
      ),
    })
  })
  app.patch('/api/chats/:id', (req, res) =>
    res.json(chats.rename(req.params.id, req.user.id, req.body)),
  )
  app.post('/api/chats/:id/title', async (req, res) =>
    res.json(await chats.suggestTitle(req.params.id, req.user.id)),
  )
  app.post('/api/chats/:id/runs', async (req, res) => {
    const chat = chats.get(req.params.id, req.user.id)
    requireNoGit(chat.projectId, req.user.id)
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      (req.body.chatId !== undefined && req.body.chatId !== chat.id)
    )
      throw Object.assign(new Error('Choose the same chat as this request.'), {
        status: 400,
      })
    const job = await agents.start(req.user.id, chat.projectId, {
      ...req.body,
      chatId: chat.id,
    })
    res.status(202).json(publicJob(events.snapshot(job.id, req.user.id)))
  })
  app.post('/api/chats/:id/trash', (req, res) =>
    res.json(chats.trash(req.user.id, req.params.id)),
  )
  app.post('/api/projects/:id/runs', async (req, res) => {
    requireNoGit(req.params.id, req.user.id)
    const job = await agents.start(req.user.id, req.params.id, req.body)
    res.status(202).json(publicJob(events.snapshot(job.id, req.user.id)))
  })
  app.get('/api/projects/:id/runs', (req, res) => {
    workspaces.get(req.params.id, req.user.id)
    res.json(
      req.query.summary === '1'
        ? events.summaries(req.user.id, req.params.id)
        : events.listMetadata(req.user.id, req.params.id).map(runMetadata),
    )
  })
  app.get('/api/runs/:id', (req, res) =>
    res.json(
      req.query.view === 'metadata'
        ? publicRunReceipt(events.snapshotMetadata(req.params.id, req.user.id))
        : publicJob(events.snapshot(req.params.id, req.user.id)),
    ),
  )
  app.get('/api/runs/:id/reasoning/:blockId', (req, res) => {
    const position = req.query.offset
    const offset =
      position === undefined
        ? 0
        : typeof position === 'string' && position.trim()
          ? Number(position)
          : NaN
    res.json(
      events.reasoningPage(
        req.params.id,
        req.user.id,
        req.params.blockId,
        offset,
      ),
    )
  })
  app.post('/api/runs/:id/messages', async (req, res) => {
    await agents.message(req.user.id, req.params.id, req.body)
    res.json(
      publicRunReceipt(events.snapshotMetadata(req.params.id, req.user.id)),
    )
  })
  for (const action of ['stop', 'undo', 'apply'])
    app.post(`/api/runs/:id/${action}`, async (req, res) => {
      await agents[action](req.user.id, req.params.id)
      res.json(publicJob(events.snapshot(req.params.id, req.user.id)))
    })
  app.get('/api/runs/:id/events', (req, res) => {
    events.getMetadata(req.params.id, req.user.id)
    const after = Number(req.headers['last-event-id'] || req.query.after || 0)
    if (!Number.isSafeInteger(after) || after < 0)
      return res.status(400).json({ error: 'Invalid event cursor.' })
    if (req.query.transport === 'poll')
      return res.json({ events: events.eventPage(req.params.id, after) })
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const send = (event) =>
      res.write(
        `id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
      )
    const existing = events.events(req.params.id, after)
    for (const event of existing) send(event)
    events.on(req.params.id, send)
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 15_000)
    req.on('close', () => {
      clearInterval(timer)
      events.off(req.params.id, send)
    })
  })
  app.use('/api/books', compression())
  installBookRoutes(app, books)
  let searches = 0
  app.post('/api/search', async (req, res) => {
    if (searches >= capacity.searches)
      throw Object.assign(new Error('Search is busy. Try again shortly.'), {
        status: 429,
      })
    searches++
    try {
      res.json(await searchDeclarations(req.body, req.user.id, workspaces))
    } finally {
      searches--
    }
  })
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'API endpoint not found.' }),
  )
  app.use(compression())
  app.use(
    express.static(path.join(projectDir, 'client/dist'), {
      index: 'index.html',
    }),
  )
  app.use((error, req, res, _next) => {
    finishSourceRequest(req)
    if (res.headersSent) return res.end()
    const message = config.redact(error.message || 'Unexpected server error.')
    res.status(error.status || error.statusCode || 500).json({ error: message })
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SOURCE_JSON_BYTES,
  })
  server.on('upgrade', (req, socket, head) => {
    const user = auth.identify(req)
    const match = /^\/websocket\/([a-zA-Z0-9_-]+)$/.exec(req.url || '')
    const terminalMatch = /^\/websocket\/terminal\/([a-zA-Z0-9_-]+)$/.exec(
      req.url || '',
    )
    const reject = (status) => {
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
      )
    }
    if (!user) return reject('401 Unauthorized')
    if (!sameOrigin(req, origin)) return reject('403 Forbidden')
    if (!match && !terminalMatch) return reject('404 Not Found')
    let project
    try {
      project = workspaces.get((terminalMatch || match)[1], user.id)
    } catch {
      return reject('404 Not Found')
    }
    if (project.status !== 'ready') return reject('409 Conflict')
    if (activity.isStopping(user.id, project.id)) return reject('409 Conflict')
    if (terminalMatch) {
      try {
        requireNoGit(project.id, user.id)
        terminals.assertCapacity(project.id)
      } catch (error) {
        return reject(
          error.status === 429 ? '429 Too Many Requests' : '409 Conflict',
        )
      }
      return terminals.upgrade(req, socket, head, project)
    }
    if (
      sockets.size >= capacity.editors ||
      (languageServers.get(project.id) || 0) >= capacity.editorsPerProject
    )
      return reject('429 Too Many Requests')
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit('connection', ws, req, project),
    )
  })
  wss.on('connection', (ws, _req, project) => {
    sockets.add(ws)
    socketProjects.set(ws, project.id)
    languageServers.set(project.id, (languageServers.get(project.id) || 0) + 1)
    let child,
      alive = true,
      lastActivity = Date.now()
    let requests, progress, editPolicy, widgetPolicy
    try {
      child = runtime.spawn(project.root, ['lake', 'serve', '--'], {
        network: 'none',
        ...(project.repairedConfiguration
          ? { readOnlyWorkspace: true, writeLakeCache: true }
          : {}),
      })
      const sendToClient = (message) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(message))
      }
      requests = new LeanRequests({
        sendToClient,
      })
      const forward = (message) => {
        if (requests.receive(message)) sendToClient(message)
      }
      editPolicy = new LeanEditPolicy({
        sendToClient: forward,
        sendToLean: (message) => child.stdin.write(frame(message)),
      })
      widgetPolicy = new LeanWidgetPolicy({
        sendToClient: forward,
        sendToLean: (message) => child.stdin.write(frame(message)),
      })
      progress = new LeanProgress(sendToClient)
      const frames = new LspFrames((message) => {
        progress.server(message)
        if (widgetPolicy.server(message) && editPolicy.server(message))
          forward(message)
      })
      child.stdout.on('data', (chunk) => {
        try {
          frames.push(chunk)
        } catch {
          ws.close(1011, 'Lean returned an invalid message.')
          child.kill()
        }
      })
      child.stderr.on('data', (chunk) =>
        console.error(
          `[LeanFlow Web · Lean ${project.id}] ${config.redact(chunk.toString()).slice(0, 2000)}`,
        ),
      )
      child.on('error', () => ws.close(1011, 'Lean could not start.'))
      child.on('close', () =>
        ws.close(1011, 'Lean stopped. Reopen the project to reconnect.'),
      )
      child.stdin.on('error', () => ws.close(1011, 'Lean connection closed.'))
      ws.on('message', (data) => {
        lastActivity = Date.now()
        try {
          const message = validateClientUris(JSON.parse(data.toString()))
          requests.track(message)
          progress.client(message)
          if (widgetPolicy.client(message) && editPolicy.client(message))
            child.stdin.write(frame(message))
        } catch (error) {
          if (error.sourceTooLarge) ws.close(1009, error.message)
          else ws.close(1008, 'Invalid Lean message or workspace path.')
        }
      })
    } catch (error) {
      ws.close(1013, config.redact(error.message).slice(0, 100))
    }
    ws.on('pong', () => {
      alive = true
    })
    const heartbeat = setInterval(() => {
      if (!alive || Date.now() - lastActivity > 30 * 60_000)
        return ws.terminate()
      alive = false
      ws.ping()
    }, 30_000)
    ws.on('close', () => {
      clearInterval(heartbeat)
      requests?.dispose()
      progress?.dispose()
      editPolicy?.dispose()
      child?.kill()
      sockets.delete(ws)
      socketProjects.delete(ws)
      languageServers.set(
        project.id,
        Math.max(0, (languageServers.get(project.id) || 1) - 1),
      )
    })
    ws.on('error', () => child?.kill())
  })
  let closePromise
  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      chats.stopNaming()
      const stopped = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
      terminals.close()
      for (const ws of sockets) ws.terminate()
      const checksStopped = jobs.shutdown(),
        agentsStopped = agents.shutdown(),
        texStopped = texBuilds.shutdown()
      await runtime.shutdown?.()
      await Promise.allSettled([
        modelDiscovery.close(),
        checksStopped,
        agentsStopped,
        texStopped,
        playgroundPreparation,
        ...workspaces.jobs.values(),
      ])
      await stopped
      chats.close()
      workspaces.close()
      events.close()
    })()
    return closePromise
  }
  return {
    app,
    server,
    auth,
    runtime,
    workspaces,
    events,
    agents,
    texBuilds,
    chats,
    config,
    settings,
    providers,
    modelDiscovery,
    modelPreferences,
    gitConnections,
    publisher,
    close,
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dataDir = path.resolve(
    process.env.STUDIO_DATA_DIR || path.join(projectDir, '.data'),
  )
  const { release } = await acquireServerLease(dataDir)
  let studio
  try {
    studio = await createStudio({ dataDir })
  } catch (error) {
    await release()
    throw error
  }
  const port = Number(process.env.PORT || 8090),
    host = process.env.HOST || '127.0.0.1'
  studio.server.listen(port, host, () =>
    console.log(
      `LeanFlow Web: ${process.env.STUDIO_ORIGIN || `http://${host}:${port}`}\nBackend: http://${host}:${port}\nPublic origin: ${process.env.STUDIO_ORIGIN || 'not configured (set STUDIO_ORIGIN for HTTPS hosting)'}\nDeveloped by EPFL LARA · https://epfl-lara.github.io/\nAccess token file: ${path.join(process.env.STUDIO_DATA_DIR || path.join(projectDir, '.data'), 'auth/owner.token')}\nLemex revision: ${studio.config.lemex.revision || 'unknown'}`,
    ),
  )
  studio.server.on('error', (error) => {
    console.error(`[LeanFlow Web] ${studio.config.redact(error.message)}`)
    studio
      .close()
      .finally(release)
      .finally(() => process.exit(1))
  })
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () =>
      studio
        .close()
        .then(release)
        .then(() => process.exit(0)),
    )
}
