import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Icon } from './Icons'
import { ResizeHandle } from './ResizeHandle'
import { useStoredSize } from './layout'
import { messageId } from './messageId'
import { errorText, sessionBoundUrl } from './api'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'

const terminalTheme = (theme: 'light' | 'dark') =>
  theme === 'dark'
    ? { background: '#12141b', foreground: '#e2e5ed', cursor: '#e2e5ed' }
    : { background: '#ffffff', foreground: '#20232b', cursor: '#20232b' }

export function TerminalPanel({
  projectId,
  projectName,
  theme,
  onClose,
  onStateChange,
  onOpeningChange,
  beforeConnect,
  needsPreparation = false,
}: {
  projectId: string
  projectName: string
  theme: 'light' | 'dark'
  onClose: () => void
  onStateChange?: (active: boolean) => void
  onOpeningChange?: (openingId: string) => void
  beforeConnect?: () => Promise<void>
  needsPreparation?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const stateChange = useRef(onStateChange)
  stateChange.current = onStateChange
  const openingChange = useRef(onOpeningChange)
  openingChange.current = onOpeningChange
  const beforeConnectRef = useRef(beforeConnect)
  beforeConnectRef.current = beforeConnect
  const themeRef = useRef(theme)
  themeRef.current = theme
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState('Connecting…')
  const [connected, setConnected] = useState(false)
  const [syncIssue, setSyncIssue] = useState<{
    state: 'paused' | 'limited'
    message: string
  } | null>(null)
  const [height, setHeight] = useStoredSize(
    'lemex-terminal-height',
    260,
    150,
    600,
  )

  useEffect(() => {
    if (!host.current) return
    stateChange.current?.(true)
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 3000,
      screenReaderMode: true,
      disableStdin: true,
      allowProposedApi: false,
      theme: terminalTheme(themeRef.current),
    })
    terminal.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    term.textarea?.setAttribute('aria-label', 'Project terminal input')
    let connection: WebSocket | null = null
    let disposed = false
    let failure = ''
    const send = (message: object) => {
      if (connection?.readyState === WebSocket.OPEN)
        connection.send(JSON.stringify(message))
    }
    const resize = () => {
      if (!host.current?.clientWidth || !host.current.clientHeight) return
      fit.fit()
      send({ type: 'resize', cols: term.cols, rows: term.rows })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host.current)
    const input = term.onData((data) => {
      // Keep large pastes within the server's per-message input limit.
      const points = Array.from(data)
      for (let i = 0; i < points.length; i += 4000)
        send({ type: 'input', data: points.slice(i, i + 4000).join('') })
    })
    // Let copy/paste shortcuts reach the browser while Ctrl+C without a
    // selection still interrupts the foreground process through the PTY.
    term.attachCustomKeyEventHandler((event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'c' &&
        term.hasSelection()
      )
        return false
      if (
        ((event.ctrlKey && event.shiftKey) || event.metaKey) &&
        event.key.toLowerCase() === 'v'
      )
        return false
      return true
    })
    setStatus(beforeConnectRef.current ? 'Saving edits…' : 'Connecting…')
    setConnected(false)
    setSyncIssue(null)
    async function connect() {
      try {
        await beforeConnectRef.current?.()
        if (disposed) return
        const url = new URL(
          `/websocket/terminal/${encodeURIComponent(projectId)}`,
          location.href,
        )
        const openingId = messageId()
        url.searchParams.set('openingId', openingId)
        openingChange.current?.(openingId)
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(sessionBoundUrl(url))
        connection = socket
        socket.binaryType = 'arraybuffer'
        setStatus('Connecting…')
        socket.onopen = () => {
          if (disposed) return socket.close()
          setStatus('Connected')
          setConnected(true)
          term.options.disableStdin = false
          resize()
          const active = document.activeElement
          if (
            active === document.body ||
            (active instanceof Element &&
              (host.current?.contains(active) ||
                active.closest(
                  '.terminal-actions, .toolbar-action[aria-label="Terminal"]',
                )))
          )
            term.focus()
        }
        socket.onmessage = (event) => {
          if (disposed) return
          if (event.data instanceof ArrayBuffer) {
            const data = new Uint8Array(event.data)
            term.write(data, () =>
              send({ type: 'ack', bytes: data.byteLength }),
            )
            return
          }
          try {
            const message: unknown = JSON.parse(String(event.data))
            if (!message || typeof message !== 'object') return
            if (
              'type' in message &&
              message.type === 'sync' &&
              'state' in message &&
              'message' in message &&
              typeof message.message === 'string'
            ) {
              if (message.state === 'synced') setSyncIssue(null)
              else if (
                message.state === 'paused' ||
                message.state === 'limited'
              )
                setSyncIssue({ state: message.state, message: message.message })
              return
            }
            if (
              'type' in message &&
              message.type === 'error' &&
              'message' in message &&
              typeof message.message === 'string'
            ) {
              failure = message.message
              setStatus(failure)
            } else if (
              'type' in message &&
              message.type === 'exit' &&
              'code' in message
            ) {
              failure =
                typeof message.code === 'number'
                  ? `Shell exited (${message.code}).`
                  : 'Shell exited.'
              setStatus(failure)
            }
          } catch {
            /* A disconnected worker can no longer send terminal messages. */
          }
        }
        socket.onerror = () => {
          failure ||=
            'Could not open the terminal. Check your sign-in, close other terminals, and try again.'
          if (!disposed) setStatus(failure)
        }
        socket.onclose = () => {
          if (disposed) return
          term.options.disableStdin = true
          setConnected(false)
          stateChange.current?.(false)
          setStatus(
            failure || 'Terminal disconnected. Reopen it to start a new shell.',
          )
        }
      } catch (error) {
        if (disposed) return
        failure = errorText(error)
        setStatus(failure)
        stateChange.current?.(false)
      }
    }
    void connect()
    return () => {
      disposed = true
      stateChange.current?.(false)
      observer.disconnect()
      input.dispose()
      connection?.close()
      term.dispose()
      terminal.current = null
    }
  }, [projectId, attempt])

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = terminalTheme(theme)
  }, [theme, attempt])

  return (
    <>
      <ResizeHandle
        className="terminal-resize-handle"
        label="Resize terminal"
        orientation="horizontal"
        value={height}
        min={150}
        max={600}
        direction={-1}
        onChange={setHeight}
        onReset={() => setHeight(260)}
      />
      <section
        className={`project-terminal ${theme}`}
        aria-label="Project terminal"
        style={{ height }}
      >
        <div className="terminal-toolbar">
          <div className="terminal-title">
            <Icon name="terminal" size={17} />
            <strong>Terminal</strong>
            <span className="terminal-project" title={projectName}>
              {projectName}
            </span>
            <span
              className="terminal-location"
              title="Commands run in your private working copy of this project."
            >
              Private working copy
            </span>
          </div>
          <output className="terminal-status" data-connected={connected}>
            <span className="terminal-status-dot" aria-hidden="true" />
            <span>{status}</span>
          </output>
          <div className="terminal-actions">
            {!connected && (
              <button
                className="button small subtle"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <Icon name="refresh" size={14} />
                Reconnect terminal
              </button>
            )}
            <button
              className="button small subtle"
              aria-label="Close terminal"
              title="Close terminal and stop its processes"
              onClick={onClose}
            >
              <Icon name="close" size={14} />
              Close
            </button>
          </div>
        </div>
        <p className="terminal-help">
          <Icon name="info" size={13} />
          <span>
            File edits sync from your private copy with conflict checks.
            Terminal Git history stays private; use Source control to publish
            project history. If updates pause, close this terminal and recover
            its files below.
            <kbd>Ctrl+C</kbd> stops a command.
          </span>
        </p>
        {needsPreparation && (
          <div className="workspace-alert terminal-setup-alert" role="status">
            Project setup changed. Finish or stop your commands, then close this
            terminal before retrying setup.
          </div>
        )}
        {syncIssue && (
          <div className="workspace-alert terminal-sync-alert" role="status">
            <span>
              <strong>
                {syncIssue.state === 'paused'
                  ? 'File syncing paused. '
                  : 'Some terminal files remain private. '}
              </strong>
              {syncIssue.message} Close this terminal to recover its private
              files below.
              {syncIssue.state === 'paused' &&
                ' Open a new terminal to start from the latest saved files.'}
            </span>
          </div>
        )}
        <div className="terminal-screen" ref={host} />
      </section>
    </>
  )
}
