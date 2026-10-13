import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AgentRpc } from './rpc.mjs'
import { TERMINAL } from './events.mjs'
import { proofRisks, verifyCandidate } from './verification.mjs'

const modes = new Set(['repair', 'prove', 'formalize', 'search'])
const instructions = await fs.readFile(
  new URL('../prompts/lean-assistant.md', import.meta.url),
  'utf8',
)

function mcpToml(servers) {
  const scalar = (value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(scalar).join(', ') + ']'
    throw new Error('MCP configuration contains an unsupported value.')
  }
  const lines = []
  const table = (prefix, value) => {
    lines.push(`[${prefix}]`)
    for (const [key, item] of Object.entries(value))
      if (!item || typeof item !== 'object' || Array.isArray(item))
        lines.push(`${JSON.stringify(key)} = ${scalar(item)}`)
    for (const [key, item] of Object.entries(value))
      if (item && typeof item === 'object' && !Array.isArray(item))
        table(`${prefix}.${JSON.stringify(key)}`, item)
  }
  for (const [name, server] of Object.entries(servers))
    table(`mcp_servers.${JSON.stringify(name)}`, server)
  return lines.join('\n')
}

export class AgentManager {
  constructor({
    runtime,
    workspaces,
    events,
    config,
    settings,
    maxConcurrent = 2,
  }) {
    Object.assign(this, {
      runtime,
      workspaces,
      events,
      config,
      settings,
      maxConcurrent,
    })
    this.active = new Map()
    this.queue = []
    this.tasks = new Set()
    this.running = 0
    this.stopping = false
  }
  start(owner, projectId, input) {
    const project = this.workspaces.get(projectId, owner)
    if (project.status !== 'ready')
      throw Object.assign(
        new Error('Prepare this project before asking Lemex to work on it.'),
        { status: 409 },
      )
    if (!this.config.provider.LEMEX_API_KEY)
      throw Object.assign(
        new Error(
          'Lemex needs a provider API key. Configure LEMEX_API_KEY on the server.',
        ),
        { status: 503 },
      )
    if (!modes.has(input.mode))
      throw Object.assign(
        new Error('Choose repair, prove, formalize, or search.'),
        { status: 400 },
      )
    if (
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      input.prompt.length > 32_000
    )
      throw Object.assign(
        new Error('Enter a task of up to 32,000 characters.'),
        { status: 400 },
      )
    if (input.file !== undefined && typeof input.file !== 'string')
      throw Object.assign(new Error('Invalid selected file.'), { status: 400 })
    const model = input.model || this.config.defaultModel
    if (!this.config.models.some((item) => item.id === model))
      throw Object.assign(
        new Error('This model is not in the server model catalog.'),
        { status: 400 },
      )
    if (this.queue.length >= 12)
      throw Object.assign(
        new Error('The assistant queue is full. Try again shortly.'),
        { status: 429 },
      )
    if (
      this.events
        .list(owner, projectId)
        .some((job) => !TERMINAL.has(job.status))
    )
      throw Object.assign(
        new Error(
          'This project already has an active Lemex run. Stop it before starting another.',
        ),
        { status: 409 },
      )
    const maxSeconds =
      input.maxSeconds === undefined ? 600 : Number(input.maxSeconds)
    if (!Number.isInteger(maxSeconds) || maxSeconds < 30 || maxSeconds > 1800)
      throw Object.assign(
        new Error('Choose a run limit between 30 and 1,800 seconds.'),
        { status: 400 },
      )
    const job = this.events.create(owner, {
      kind: 'agent',
      projectId,
      mode: input.mode,
      prompt: input.prompt.trim(),
      file: input.file || null,
      model,
      maxSeconds,
    })
    this.queue.push(job.id)
    queueMicrotask(() => this.#drain())
    return job
  }
  #emit(id, type, data) {
    this.events.event(
      id,
      type,
      JSON.parse(this.config.redact(JSON.stringify(data))),
    )
  }
  #log(id, text) {
    this.events.append(id, 'log', this.config.redact(text), 'activity')
  }
  #drain() {
    while (
      !this.stopping &&
      this.running < this.maxConcurrent &&
      this.queue.length
    ) {
      const id = this.queue.shift()
      if (this.events.get(id).status === 'cancelled') continue
      this.running++
      const task = this.#execute(id)
        .catch((error) => {
          if (this.events.get(id).status !== 'cancelled') {
            const message = this.config.redact(error.message)
            this.events.update(id, { status: 'failed', error: message })
            this.#emit(id, 'error', { message })
          }
        })
        .finally(() => {
          this.running--
          this.tasks.delete(task)
          this.#drain()
        })
      this.tasks.add(task)
    }
  }
  async #execute(id) {
    const job = this.events.get(id)
    const active = {
      controller: new AbortController(),
      rpc: null,
      threadId: null,
      turnId: null,
      timeout: null,
    }
    this.active.set(id, active)
    active.timeout = setTimeout(() => {
      this.stop(job.owner, id, 'The run reached its time limit.')
    }, job.maxSeconds * 1000)
    try {
      this.events.update(id, { status: 'running' })
      if (job.file)
        await this.workspaces.readFile(job.projectId, job.owner, job.file)
      this.#log(id, 'Capturing a separate copy of the saved project…\n')
      const snapshot = await this.workspaces.snapshot(
        job.projectId,
        job.owner,
        id,
      )
      this.events.update(id, {
        snapshot,
        sourceRevision: snapshot.sourceRevision,
      })
      if (active.controller.signal.aborted) return
      const home = await this.runtime.home(snapshot.root)
      const preferences = await this.settings.get(job.owner)
      const config =
        [
          'model_provider = "rcp"',
          `model = ${JSON.stringify(job.model)}`,
          'model_catalog_json = "models.json"',
          'web_search = "disabled"',
          'model_context_window = 200000',
          'model_auto_compact_token_limit = 180000',
          '[mcp_servers.lean]',
          'command = "/opt/tools/bin/lean-lsp-mcp"',
          'args = ["--lean-project-path", "/workspace"]',
          'startup_timeout_sec = 90',
          'tool_timeout_sec = 120',
          `enabled = ${preferences.tools.lean}`,
          '[mcp_servers.lean_explore]',
          'url = "https://www.leanexplore.com/mcp"',
          'startup_timeout_sec = 30',
          'tool_timeout_sec = 60',
          `enabled = ${preferences.tools.lean_explore}`,
          '[mcp_servers.exa]',
          'url = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa"',
          'startup_timeout_sec = 30',
          'tool_timeout_sec = 60',
          `enabled = ${preferences.tools.exa}`,
          '[analytics]',
          'enabled = false',
          '[feedback]',
          'enabled = false',
          '[otel]',
          'metrics_exporter = "none"',
          mcpToml(this.config.mcp || {}),
        ].join('\n') + '\n'
      await fs.writeFile(path.join(home, '.lemex/config.toml'), config, {
        mode: 0o600,
      })
      if (active.controller.signal.aborted) return
      const child = this.runtime.spawn(
        snapshot.root,
        ['lemex', 'app-server', '--stdio', '--strict-config'],
        {
          env: this.config.provider,
          network: 'bridge',
          signal: active.controller.signal,
        },
      )
      const rpc = (active.rpc = new AgentRpc(child))
      child.stderr.on('data', (text) => {
        // Runtime debug messages stay server-side; only bounded useful failures are surfaced.
        const value = this.config.redact(text.toString())
        if (/ERROR|failed|error:/i.test(value))
          this.#log(id, value.slice(0, 2000))
      })
      const seenDeltas = new Set()
      let resolveFinished, rejectFinished
      const finished = new Promise((resolve, reject) => {
        resolveFinished = resolve
        rejectFinished = reject
      })
      // This promise may reject before turn/start returns; attach immediately.
      finished.catch(() => {})
      rpc.on('closed', rejectFinished)
      rpc.on('request', (request) => {
        this.#log(
          id,
          `Lemex requested ${request.method}; interactive escalation was declined.\n`,
        )
        try {
          if (/requestApproval$/.test(request.method))
            rpc.respond(request.id, { decision: 'decline' })
          else if (request.method === 'item/tool/requestUserInput')
            rpc.respond(request.id, { answers: {} })
          else if (request.method === 'mcpServer/elicitation/request')
            rpc.respond(request.id, { action: 'decline', content: null })
          else
            rpc.send({
              id: request.id,
              error: {
                code: -32601,
                message:
                  'This client does not implement this interactive request.',
              },
            })
        } catch {}
      })
      rpc.on('notification', ({ method, params }) => {
        if (this.events.get(id).status === 'cancelled') return
        if (method === 'item/agentMessage/delta') {
          seenDeltas.add(params.itemId)
          this.events.append(
            id,
            'message',
            this.config.redact(params.delta || ''),
            'message',
          )
        } else if (method === 'item/started') {
          const item = params.item || {}
          if (item.type === 'commandExecution')
            this.#log(id, `Running ${item.command || 'a workspace command'}\n`)
          if (item.type === 'mcpToolCall')
            this.#log(
              id,
              `Using ${item.server || ''} / ${item.tool || 'Lean tool'}\n`,
            )
          if (item.type === 'fileChange')
            this.#log(id, 'Preparing a candidate edit…\n')
        } else if (method === 'item/completed') {
          const item = params.item || {}
          if (
            item.type === 'agentMessage' &&
            item.text &&
            !seenDeltas.has(item.id)
          )
            this.events.append(
              id,
              'message',
              this.config.redact(item.text),
              'message',
            )
          if (item.type === 'commandExecution' && item.exitCode !== 0)
            this.#log(
              id,
              `Command finished with exit code ${item.exitCode ?? 'unknown'}.\n`,
            )
          if (item.type === 'mcpToolCall' && item.error)
            this.#log(id, `Tool reported: ${JSON.stringify(item.error)}\n`)
        } else if (method === 'thread/tokenUsage/updated') {
          this.events.update(id, { usage: params.tokenUsage })
          this.#emit(id, 'usage', params.tokenUsage)
        } else if (method === 'turn/started') active.turnId = params.turn?.id
        else if (method === 'turn/completed') resolveFinished(params.turn)
        else if (method === 'error')
          this.#log(
            id,
            `${params.error?.message || params.message || 'Lemex reported an error'}\n`,
          )
      })
      await rpc.call('initialize', {
        clientInfo: { name: 'lemex_web', title: 'Lemex Web', version: '0.1.0' },
      })
      rpc.notify('initialized')
      const project = this.workspaces.get(job.projectId, job.owner)
      const thread = await rpc.call('thread/start', {
        model: job.model,
        cwd: '/workspace',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        developerInstructions:
          instructions +
          `\nCurrent mode: ${job.mode}.\nProject toolchain: ${project.toolchain}.\n\nUser's additional project guidance:\n${preferences.extraInstructions}`,
        ephemeral: false,
      })
      active.threadId = thread.thread.id
      this.events.update(id, { threadId: active.threadId })
      this.#log(id, `Lemex is working in ${job.mode} mode.\n`)
      const turn = await rpc.call('turn/start', {
        threadId: active.threadId,
        input: [
          {
            type: 'text',
            text: `${job.file ? `Selected saved file: ${job.file}\n\n` : ''}${job.prompt}`,
            textElements: [],
          },
        ],
      })
      active.turnId = turn.turn.id
      const result = await finished
      rpc.close()
      active.rpc = null
      if (active.controller.signal.aborted) return
      if (result.status !== 'completed')
        throw new Error(result.error?.message || `Lemex turn ${result.status}.`)
      this.events.update(id, { status: 'verifying' })
      const changes = await this.workspaces.changes(snapshot)
      this.events.update(id, { changes })
      this.#emit(id, 'changes', { changes })
      if (job.mode === 'search' && changes.length)
        throw new Error(
          'Search mode modified files. Those changes will not be applied.',
        )
      if (job.mode === 'search') {
        const verification = {
          compiled: true,
          complete: true,
          files: [],
          axioms: [],
          reason: 'Search completed without changing project files.',
        }
        this.events.update(id, { verification, status: 'completed' })
        this.#emit(id, 'verification', verification)
        return
      }
      const risks = proofRisks(changes, job.mode)
      if (risks.length) {
        const verification = {
          compiled: false,
          complete: false,
          files: [],
          errors: risks,
          reason: 'Candidate requires manual review.',
        }
        this.events.update(id, { verification, status: 'completed' })
        this.#emit(id, 'verification', verification)
        return
      }
      this.#log(id, 'Checking the candidate independently with Lean…\n')
      const clean = await this.workspaces.verificationCopy(snapshot, changes)
      this.events.update(id, { verificationRoot: clean.root })
      let checks = changes
      if (
        !changes.length &&
        job.mode !== 'search' &&
        job.file?.endsWith('.lean')
      ) {
        const unchanged = await this.workspaces.readFile(
          job.projectId,
          job.owner,
          job.file,
        )
        checks = [
          {
            path: job.file,
            before: unchanged.content,
            after: unchanged.content,
            beforeHash: unchanged.hash,
          },
        ]
      }
      const verification = await verifyCandidate(
        this.runtime,
        clean.root,
        checks,
        job.mode,
        (text) => this.#log(id, text),
        { signal: active.controller.signal },
      )
      if (active.controller.signal.aborted) return
      this.events.update(id, { verification, status: 'completed' })
      this.#emit(id, 'verification', verification)
    } finally {
      clearTimeout(active.timeout)
      active.rpc?.close()
      this.active.delete(id)
    }
  }
  stop(owner, id, reason = 'Stopped by the user.') {
    const job = this.events.get(id, owner)
    if (TERMINAL.has(job.status)) return job
    const active = this.active.get(id)
    this.events.update(id, { status: 'cancelled', error: reason })
    active?.controller.abort()
    if (active?.rpc && active.threadId && active.turnId)
      active.rpc
        .call(
          'turn/interrupt',
          { threadId: active.threadId, turnId: active.turnId },
          2000,
        )
        .catch(() => {})
    active?.rpc?.close()
    return this.events.get(id, owner)
  }
  async apply(owner, id) {
    const job = this.events.get(id, owner)
    if (job.status === 'applied') return job
    if (job.status !== 'completed' || !job.verification?.complete)
      throw Object.assign(
        new Error(
          'Only a completed candidate that passed independent Lean verification can be applied.',
        ),
        { status: 409 },
      )
    if (!job.changes.length)
      throw Object.assign(new Error('This run has no changes to apply.'), {
        status: 409,
      })
    await this.workspaces.applyChanges(job.projectId, owner, job.changes, {
      snapshot: job.snapshot,
    })
    this.#log(id, 'Accepted candidate changes.\n')
    return this.events.update(id, { status: 'applied' })
  }
  async shutdown() {
    this.stopping = true
    for (const id of this.queue)
      this.stop(this.events.get(id).owner, id, 'The server is shutting down.')
    this.queue.length = 0
    for (const [id] of this.active)
      this.stop(this.events.get(id).owner, id, 'The server is shutting down.')
    await Promise.allSettled([...this.tasks])
  }
}
