import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const socketName = '.git-credentials.sock'
const maxRequest = 16 * 1024
const maxConnections = 16

// Git captures this helper's output. Neither the shell nor its environment
// receives the token; the connection is looked up afresh for each Git request.
const helperScript = `import json, socket, sys
if len(sys.argv) < 2 or sys.argv[1] != "get":
    sys.exit(0)
try:
    incoming = sys.stdin.buffer.read(16385)
    if len(incoming) > 16384:
        sys.exit(0)
    fields = dict(line.split("=", 1) for line in incoming.decode().splitlines() if "=" in line)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(5)
    client.connect("/home/worker/${socketName}")
    client.sendall((json.dumps({key: fields.get(key, "") for key in ["protocol", "host", "path"]}) + "\\n").encode())
    response = b""
    while b"\\n" not in response and len(response) <= 32768:
        chunk = client.recv(4096)
        if not chunk:
            break
        response += chunk
    client.close()
    if len(response) > 32768:
        sys.exit(0)
    credentials = json.loads(response.split(b"\\n", 1)[0])
    if credentials.get("token"):
        print("username=" + credentials["username"])
        print("password=" + credentials["token"])
except (OSError, ValueError, KeyError):
    pass
`

export const terminalGitHelper =
  "!/usr/bin/python3 -c '" + helperScript.replaceAll("'", "'\"'\"'") + "'"

export function terminalGitEnvironment() {
  const configuration = [
    ['credential.helper', ''],
    ['credential.helper', terminalGitHelper],
    ['credential.useHttpPath', 'true'],
    ['http.followRedirects', 'false'],
    ['http.sslVerify', 'true'],
  ]
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(configuration.length),
  }
  configuration.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

function requestUrl(request) {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    request.protocol !== 'https' ||
    typeof request.host !== 'string' ||
    !request.host ||
    request.host.length > 260 ||
    /[\s/@\\?#%]/.test(request.host) ||
    (request.path !== undefined &&
      (typeof request.path !== 'string' ||
        request.path.length > 4000 ||
        /[\\?#]/.test(request.path) ||
        [...request.path].some(
          (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
        )))
  )
    return null
  try {
    const url = new URL(`https://${request.host}/${request.path || ''}`)
    if (url.port || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export async function createTerminalGitBroker({ home, owner, connections }) {
  const directory = await fs.open(
    home,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  const sockets = new Set()
  let server
  let closing = false
  let failed = false
  let lookups = 0
  try {
    if (
      (await fs.realpath(`/proc/self/fd/${directory.fd}`)) !==
      path.resolve(home)
    )
      throw new Error('The terminal home changed before Git connected.')
    // Linux's Unix socket path limit is 108 bytes. Managed homes have long
    // random names; the open directory anchors a short alias to the same inode.
    const address = `/proc/self/fd/${directory.fd}/${socketName}`
    server = net.createServer((socket) => {
      sockets.add(socket)
      socket.setTimeout(5000, () => socket.destroy())
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
      let input = ''
      let received = false
      socket.on('data', async (chunk) => {
        if (received) return
        input += chunk.toString('utf8')
        if (Buffer.byteLength(input) > maxRequest) return socket.destroy()
        const newline = input.indexOf('\n')
        if (newline < 0) return
        received = true
        let credentials
        try {
          const url = requestUrl(JSON.parse(input.slice(0, newline)))
          if (url && !closing && !failed && lookups < maxConnections) {
            ++lookups
            try {
              credentials = await connections.credentials(owner, url)
            } finally {
              --lookups
            }
          }
          if (!closing && !socket.destroyed)
            socket.end(JSON.stringify(credentials || {}) + '\n')
          else socket.destroy()
        } catch {
          socket.end('{}\n')
        } finally {
          if (credentials) credentials.token = ''
        }
      })
    })
    server.maxConnections = maxConnections
    server.on('error', () => {
      failed = true
      for (const socket of sockets) socket.destroy()
      if (server.listening) server.close()
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ path: address, backlog: maxConnections }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await fs.chmod(address, 0o600)
    return {
      async close() {
        if (closing) return
        closing = true
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => server.close(resolve))
        await fs.rm(address, { force: true })
        await directory.close()
      },
    }
  } catch (error) {
    closing = true
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    await directory.close()
    throw error
  }
}
