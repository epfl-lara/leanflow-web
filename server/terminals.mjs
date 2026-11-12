import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { removeDisposableTree } from './temporary-workspaces.mjs'
import { TerminalSourceMirror } from './terminal-live.mjs'
import {
  createTerminalGitBroker,
  terminalGitEnvironment,
} from './terminal-git.mjs'

const workerScript = readFileSync(
  new URL('./terminal-worker.py', import.meta.url),
  'utf8',
)
const maxInput = 16 * 1024
const outputWindow = 256 * 1024

export function validateTerminalOpeningId(value) {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw Object.assign(
      new Error(
        'This terminal request is invalid. Reopen the terminal and retry.',
      ),
      { status: 400 },
    )
  return value.toLowerCase()
}

export class Terminals {
  constructor({
    runtime,
    capacity,
    workspaces,
    gitConnections,
    gitIdentity,
    redact = String,
    isAuthenticated = () => true,
  }) {
    Object.assign(this, {
      runtime,
      capacity,
      workspaces,
      gitConnections,
      gitIdentity,
      redact,
      isAuthenticated,
    })
    this.sessions = new Set()
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
  }

  assertIdle(projectId, { ignoreRunId, actor } = {}) {
    const blocking = [...this.sessions].find(
      (session) =>
        session.projectId === projectId &&
        (ignoreRunId === undefined || session.snapshot?.runId !== ignoreRunId),
    )
    if (blocking)
      throw Object.assign(
        new Error(
          actor !== undefined && blocking.actor !== actor
            ? 'Another collaborator has a project terminal open or finishing its file updates. Ask them to close it, then try again.'
            : 'Close the project terminal and wait for its file updates before preparing, publishing, or moving project data.',
        ),
        { status: 409 },
      )
  }

  assertCapacity(projectId) {
    if (
      this.sessions.size >= (this.capacity.terminals ?? 2) ||
      [...this.sessions].filter((session) => session.projectId === projectId)
        .length >= (this.capacity.terminalsPerProject ?? 1)
    )
      throw Object.assign(
        new Error(
          'Terminal capacity is full. Close another terminal and try again.',
        ),
        { status: 429 },
      )
  }

  upgrade(req, socket, head, project, actor = project.owner, options = {}) {
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.connect(ws, project, actor, req, options),
    )
  }

  connect(ws, project, actor = project.owner, request, { openingId } = {}) {
    const session = { ws, projectId: project.id, actor, openingId }
    this.sessions.add(session)
    let child
    const assertAuthenticated = () => {
      if (this.isAuthenticated(request, actor)) return
      ws.close(1008, 'Account access changed. Sign in again.')
      child?.kill()
      throw Object.assign(new Error('Account access changed. Sign in again.'), {
        status: 401,
      })
    }
    let broker
    let setup = Promise.resolve()
    let initialized = false
    const pendingInput = []
    let outstanding = 0
    let lastActivity = Date.now()
    let alive = true
    const startupController = new AbortController()
    const notice = (message) => {
      if (ws.readyState !== 1) return
      try {
        assertAuthenticated()
      } catch {
        return
      }
      const output = Buffer.from(`\r\n[LeanFlow] ${message}\r\n`)
      outstanding += output.length
      ws.send(output, { binary: true })
    }
    let lastSyncStatus = ''
    const syncStatus = (state, message = '') => {
      const packet = JSON.stringify({ type: 'sync', state, message })
      if (ws.readyState !== 1 || packet === lastSyncStatus) return
      try {
        assertAuthenticated()
      } catch {
        return
      }
      lastSyncStatus = packet
      ws.send(packet)
    }
    const fail = (message, code = 1011) => {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'error', message }))
      ws.close(code, 'Terminal closed')
      child?.kill()
    }
    const startupTimeout = setTimeout(() => {
      startupController.abort(new Error('Terminal startup timed out.'))
      fail(
        session.waitingForWorker
          ? 'Terminal capacity is busy. Close an unused editor or terminal, then retry.'
          : 'The private terminal copy took too long to prepare. Close it and retry.',
      )
    }, 60_000)
    startupTimeout.unref?.()
    const heartbeat = setInterval(() => {
      try {
        assertAuthenticated()
      } catch {
        return
      }
      if (!alive || Date.now() - lastActivity > 30 * 60_000) {
        child?.kill()
        return ws.terminate()
      }
      alive = false
      ws.ping()
    }, 30_000)
    ws.on('pong', () => {
      alive = true
    })
    ws.on('error', () => child?.kill())
    ws.on('close', () => {
      startupController.abort(new Error('Terminal closed.'))
      clearInterval(heartbeat)
      child?.kill()
      if (!child && !session.starting) this.sessions.delete(session)
    })
    ws.on('message', (raw, binary) => {
      try {
        assertAuthenticated()
        this.workspaces?.requireEditor?.(project.id, actor)
        const message = JSON.parse(raw.toString())
        if (
          binary ||
          !message ||
          typeof message !== 'object' ||
          Array.isArray(message)
        )
          throw new Error()
        if (message.type === 'ack') {
          if (
            !Number.isSafeInteger(message.bytes) ||
            message.bytes <= 0 ||
            message.bytes > outstanding
          )
            throw new Error()
          outstanding -= message.bytes
          lastActivity = Date.now()
          if (outstanding < outputWindow / 2) child?.stdout.resume()
          return
        }
        if (message.type === 'input') {
          if (
            typeof message.data !== 'string' ||
            Buffer.byteLength(message.data) > maxInput
          )
            throw new Error()
        } else if (message.type === 'resize') {
          if (
            ![message.cols, message.rows].every(
              (value) =>
                Number.isSafeInteger(value) && value >= 1 && value <= 1000,
            )
          )
            throw new Error()
        } else throw new Error()
        lastActivity = Date.now()
        if ((child?.stdin.writableLength || 0) > 64 * 1024)
          return fail(
            'Too much terminal input is waiting. Reopen the terminal and send a smaller paste.',
            1008,
          )
        // Forward only validated fields. Clients cannot select a root, command, or environment.
        const input =
          message.type === 'input'
            ? { type: 'input', data: message.data }
            : { type: 'resize', cols: message.cols, rows: message.rows }
        if (initialized) child.stdin.write(JSON.stringify(input) + '\n')
        else {
          if (pendingInput.length >= 8)
            return fail('Too much terminal input arrived before startup.', 1008)
          pendingInput.push(input)
        }
      } catch {
        fail('Invalid terminal input. Reopen the terminal to continue.', 1008)
      }
    })
    let startupCleanup
    session.finalize = () => {
      startupCleanup ||= (async () => {
        if (session.snapshot)
          await this.workspaces.cleanupTerminalSnapshot(session.snapshot, {
            finalize: true,
          })
        this.sessions.delete(session)
      })().catch((error) => {
        startupCleanup = undefined
        throw error
      })
      return startupCleanup
    }
    const start = async () => {
      try {
        assertAuthenticated()
        this.workspaces?.requireEditor?.(project.id, actor)
        const runtimeStatus = this.runtime.info?.()
        const limits = runtimeStatus?.workloads
        if (
          limits?.interactiveLimit > 0 &&
          limits.active.interactive >= limits.interactiveLimit
        )
          throw Object.assign(
            new Error(
              'Interactive capacity is full. Close an unused editor or terminal, then reopen this terminal.',
            ),
            { status: 429 },
          )
        if (this.workspaces?.terminalSnapshot) {
          session.snapshot = await this.workspaces.terminalSnapshot(
            project.id,
            actor,
            randomUUID(),
            { signal: startupController.signal },
          )
          if (ws.readyState !== 1) return
          assertAuthenticated()
          this.workspaces.requireEditor(project.id, actor)
        }
        const configuration = this.workspaces?.configurationFingerprint(
          project.id,
          actor,
        )
        // Sharing a nested project never grants a shell in its parent checkout.
        // Members can use Source control for repository operations outside root.
        const checkout =
          !session.snapshot && actor === project.owner
            ? this.workspaces?.repositoryRoot?.(project)
            : null
        const spawn = this.runtime.spawnWhenAvailable || this.runtime.spawn
        child = await spawn.call(
          this.runtime,
          session.snapshot?.root || project.root,
          ['python3', '-u', '-c', workerScript],
          {
            workload: 'interactive',
            signal: startupController.signal,
            onQueued: () => {
              session.waitingForWorker = true
              notice(
                'Waiting for an available worker. Close unused editors or terminals, or wait for running project work to finish.',
              )
            },
            onSpawn: (spawned) => {
              session.waitingForWorker = false
              child = spawned
              session.child = spawned
            },
            beforeSpawn: () => {
              startupController.signal.throwIfAborted()
              assertAuthenticated()
              this.workspaces?.requireEditor?.(project.id, actor)
            },
            network: 'bridge',
            freshHome: true,
            cleanHome: true,
            ...(checkout && checkout !== project.root
              ? { repositoryRoot: checkout }
              : {}),
            env: {
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
              PS1: '\\w \\$ ',
              ...(this.gitConnections ? terminalGitEnvironment() : {}),
            },
          },
        )
        session.child = child
        const preserve = (error) => {
          const status = error.status || error.statusCode
          const message = [403, 404].includes(status)
            ? 'Your project access changed. Download this private copy from Account settings to keep your files. Ask a project Admin to restore editing access before publishing.'
            : status
              ? this.redact(error.message)
              : 'The file updates could not be published. Your private working copy is preserved for recovery.'
          session.recovery = true
          session.publicationPaused = true
          session.recoveryMessage = message
          syncStatus('paused', message)
          notice(
            `File updates paused: ${message} Close this terminal to recover its preserved private working copy (${session.snapshot.runId}) from /api/projects/${project.id}/terminal-recoveries/${session.snapshot.runId}/download.`,
          )
        }
        if (session.snapshot)
          session.mirror = new TerminalSourceMirror({
            workspaces: this.workspaces,
            snapshot: session.snapshot,
            assertAuthorized: assertAuthenticated,
            onUnpublished: (paths) => {
              if (session.publicationPaused) return
              session.recovery = paths.length > 0
              if (!paths.length) {
                session.unpublished = ''
                syncStatus('synced')
                return
              }
              const fingerprint = paths.join('\0')
              if (fingerprint === session.unpublished) return
              session.unpublished = fingerprint
              session.recoveryMessage = `Some generated, binary or oversized files remain in this private terminal copy: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}. Download the copy to recover them. Text changes continue to publish.`
              syncStatus('limited', session.recoveryMessage)
              notice(session.recoveryMessage)
            },
            onConflict: preserve,
            onError: preserve,
          })
        child.stdout.on('data', (chunk) => {
          if (ws.readyState !== 1) return
          try {
            assertAuthenticated()
          } catch {
            return
          }
          lastActivity = Date.now()
          outstanding += chunk.length
          if (outstanding >= outputWindow) child.stdout.pause()
          ws.send(chunk, { binary: true }, (error) => {
            if (error) child.kill()
          })
        })
        // Startup diagnostics stay server-side and never include provider credentials.
        child.stderr.on('data', (chunk) =>
          console.error(
            `[LeanFlow terminal] ${this.redact(chunk.toString()).slice(0, 2000)}`,
          ),
        )
        child.stdin.on('error', () =>
          fail('Terminal input closed. Reopen the terminal to continue.'),
        )
        child.on('error', () =>
          fail(
            'The terminal could not start. Reopen it, or ask the administrator to check the worker service.',
          ),
        )
        child.on('close', (code) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'exit', code }))
            ws.close(1000, 'Shell exited')
          }
        })
        session.finalize = async () => {
          this.workspaces?.markTerminalFinalizing?.(session.snapshot)
          await setup.catch(() => {})
          await broker?.close()
          await session.mirror?.stop({ flush: true })
          if (configuration !== undefined && !session.snapshot) {
            try {
              await this.workspaces.refreshExternalConfiguration(
                project.id,
                actor,
                configuration,
              )
            } catch (error) {
              if (![403, 404].includes(error.status)) throw error
            }
          }
          if (session.snapshot) {
            if (session.recovery)
              await this.workspaces.retainTerminalSnapshot(
                session.snapshot,
                session.recoveryMessage,
              )
            else
              await this.workspaces.cleanupTerminalSnapshot(session.snapshot, {
                finalize: true,
              })
          }
          this.sessions.delete(session)
          try {
            if (child.workerHome) await removeDisposableTree(child.workerHome)
          } catch {
            console.error(
              '[LeanFlow terminal] Could not remove a closed terminal home.',
            )
          }
        }
        session.finished = (
          child.workerStopped ||
          new Promise((resolve) => child.once('close', resolve))
        ).then(session.finalize)
        // Retain failed cleanup guards for an explicit stop/Trash retry.
        session.finished.catch(() => {})
        setup = (async () => {
          if (this.gitConnections) {
            if (!child.workerHome)
              throw new Error(
                'The terminal worker has no private credential home.',
              )
            broker = await createTerminalGitBroker({
              home: child.workerHome,
              owner: actor,
              connections: this.gitConnections,
            })
          }
          const identity = this.gitIdentity
            ? await this.gitIdentity(actor)
            : (await this.gitConnections?.get(actor))?.identity
          if (ws.readyState !== 1 || child.killed) return
          assertAuthenticated()
          this.workspaces?.requireEditor?.(project.id, actor)
          child.stdin.write(JSON.stringify({ type: 'setup', identity }) + '\n')
          initialized = true
          clearTimeout(startupTimeout)
          if (session.snapshot) {
            notice(
              'Private working copy. File changes sync with conflict checks; Source control publishes the project history. If a conflict appears, this copy is preserved for recovery.',
            )
            session.mirror.start()
          }
          for (const input of pendingInput)
            child.stdin.write(JSON.stringify(input) + '\n')
          pendingInput.length = 0
        })()
        setup.catch(() =>
          fail('Git setup could not start. Reopen the terminal to try again.'),
        )
        await setup
      } catch (error) {
        console.error(
          `[LeanFlow terminal] ${this.redact(error.message).slice(0, 2000)}`,
        )
        fail(
          error.status >= 400 && error.status < 500
            ? this.redact(error.message)
            : 'The terminal could not start. Close an unused terminal or editor and try again. If it still fails, ask the administrator to check the worker service.',
        )
      } finally {
        clearTimeout(startupTimeout)
        session.starting = false
        if (!child) await session.finalize()
      }
    }
    session.starting = true
    session.startup = start()
    session.startup.catch(() => {})
  }

  async closeProject(projectId, actor, { openingId } = {}) {
    await Promise.all(
      [...this.sessions]
        .filter(
          (session) =>
            session.projectId === projectId &&
            (actor === undefined || session.actor === actor) &&
            (openingId === undefined ||
              session.openingId === openingId ||
              // Reconnects have a new ID, but a closed predecessor may still
              // need its failed worker cleanup or final publication retried.
              // Other tabs with an open socket retain their own live shells.
              session.ws.readyState !== 1),
        )
        .map(async (session) => {
          session.ws.close(1000, 'Terminal closed')
          session.child?.kill()
          try {
            await session.startup
          } catch (error) {
            if (session.child) throw error
            // A failed startup keeps its private copy guarded until cleanup
            // succeeds. Retry that cleanup even though no worker was started.
            await session.finalize()
          }
          session.child?.kill()
          try {
            await session.finished
          } catch (error) {
            if (!session.child?.cleanupWorker) throw error
            await session.child.cleanupWorker()
            await session.finalize()
          }
        }),
    )
  }

  async close() {
    const sessions = [...this.sessions]
    const stopped = sessions.map(async (session) => {
      session.ws.terminate()
      session.child?.kill()
      await session.startup
      session.child?.kill()
      await session.finished
    })
    this.wss.close()
    const results = await Promise.allSettled(stopped)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}
