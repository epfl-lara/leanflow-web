import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { removeDisposableTree } from './temporary-workspaces.mjs'

const workerScript = readFileSync(
  new URL('./terminal-worker.py', import.meta.url),
  'utf8',
)
const maxInput = 16 * 1024
const outputWindow = 256 * 1024

export class Terminals {
  constructor({ runtime, capacity, workspaces, redact = String }) {
    Object.assign(this, { runtime, capacity, workspaces, redact })
    this.sessions = new Set()
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
  }

  assertIdle(projectId) {
    if ([...this.sessions].some((session) => session.projectId === projectId))
      throw Object.assign(
        new Error(
          'Close the project terminal before preparing, publishing, or moving project data.',
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

  upgrade(req, socket, head, project) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, project))
  }

  connect(ws, project) {
    const session = { ws, projectId: project.id }
    this.sessions.add(session)
    let child
    let outstanding = 0
    let lastActivity = Date.now()
    let alive = true
    const fail = (message, code = 1011) => {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'error', message }))
      ws.close(code, 'Terminal closed')
      child?.kill()
    }
    const heartbeat = setInterval(() => {
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
      clearInterval(heartbeat)
      child?.kill()
      if (!child) this.sessions.delete(session)
    })
    try {
      const configuration = this.workspaces?.configurationFingerprint(
        project.id,
        project.owner,
      )
      child = this.runtime.spawn(
        project.root,
        ['python3', '-u', '-c', workerScript],
        {
          network: 'bridge',
          freshHome: true,
          cleanHome: true,
          env: {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            PS1: '\\w \\$ ',
          },
        },
      )
      session.child = child
      child.stdout.on('data', (chunk) => {
        if (ws.readyState !== 1) return
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
        if (configuration !== undefined) {
          try {
            await this.workspaces.refreshExternalConfiguration(
              project.id,
              project.owner,
              configuration,
            )
          } catch (error) {
            if (error.status !== 404) throw error
          }
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
      ws.on('message', (raw, binary) => {
        try {
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
            if (outstanding < outputWindow / 2) child.stdout.resume()
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
          if (child.stdin.writableLength > 64 * 1024)
            return fail(
              'Too much terminal input is waiting. Reopen the terminal and send a smaller paste.',
              1008,
            )
          // Forward only validated fields. Clients cannot select a root, command, or environment.
          const input =
            message.type === 'input'
              ? { type: 'input', data: message.data }
              : { type: 'resize', cols: message.cols, rows: message.rows }
          child.stdin.write(JSON.stringify(input) + '\n')
        } catch {
          fail('Invalid terminal input. Reopen the terminal to continue.', 1008)
        }
      })
    } catch (error) {
      console.error(
        `[LeanFlow terminal] ${this.redact(error.message).slice(0, 2000)}`,
      )
      fail(
        error.status === 409
          ? 'The project environment changed. Close the terminal and use Prepare again before reopening it.'
          : 'The terminal could not start. Close an unused terminal or editor and try again. If it still fails, ask the administrator to check the worker service.',
      )
    }
  }

  async closeProject(projectId) {
    await Promise.all(
      [...this.sessions]
        .filter((session) => session.projectId === projectId)
        .map(async (session) => {
          session.ws.close(1000, 'Terminal closed')
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

  close() {
    for (const session of this.sessions) session.ws.terminate()
    this.wss.close()
  }
}
