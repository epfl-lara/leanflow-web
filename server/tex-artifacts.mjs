import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

const limits = new Map([
  ['result.json', 1024 * 1024],
  ['document.pdf', 16 * 1024 * 1024],
  ['document.txt', 512 * 1024],
])
const maxFrame = 26 * 1024 * 1024
const maxLog = 256 * 1024
const invalid = () =>
  Object.assign(
    new Error(
      'The LaTeX worker returned invalid or oversized output. Retry or contact the server administrator.',
    ),
    { status: 502 },
  )

export function createTexArtifactReceiver(token, onOutput, onFailure) {
  const prefix = `LEANFLOW_TEX_ARTIFACTS:${token}:`
  const framePrefix = 'LEANFLOW_TEX_ARTIFACTS:'
  let output = '',
    line = '',
    mode = 'prefix',
    displayed = 0,
    stderrSize = 0,
    error
  const fail = () => {
    if (!error) {
      error = invalid()
      onFailure(error)
    }
  }
  const display = (value) => {
    const accepted = value.slice(0, Math.max(0, maxLog - displayed))
    displayed += accepted.length
    if (accepted) {
      try {
        onOutput?.(accepted, 'stdout')
      } catch {
        fail()
      }
    }
  }
  return {
    append(text, stream) {
      if (error) return
      if (stream === 'stderr') {
        stderrSize += text.length
        if (stderrSize > maxLog) fail()
        return
      }
      if (stream !== 'stdout') return
      if (output.length + text.length > maxFrame + maxLog + prefix.length) {
        fail()
        return
      }
      output += text
      for (const part of text.split(/(?<=\n)/)) {
        if (!part) continue
        if (mode === 'prefix') {
          line += part
          if (line.startsWith(framePrefix)) mode = 'frame'
          else if (!framePrefix.startsWith(line)) {
            display(line)
            mode = 'log'
            line = ''
          }
        } else if (mode === 'log') display(part)
        if (part.endsWith('\n')) {
          if (mode === 'prefix') display(line)
          line = ''
          mode = 'prefix'
        }
      }
    },
    async publish(directory) {
      if (error) throw error
      const rows = output.split('\n')
      const frames = rows.filter((row) => row.startsWith(framePrefix))
      if (
        frames.length !== 1 ||
        !frames[0].startsWith(prefix) ||
        frames[0].length > maxFrame
      )
        throw invalid()
      let frame
      try {
        frame = JSON.parse(frames[0].slice(prefix.length))
      } catch {
        throw invalid()
      }
      if (
        !frame ||
        typeof frame !== 'object' ||
        Array.isArray(frame) ||
        Object.keys(frame).length !== 1 ||
        !frame.artifacts ||
        typeof frame.artifacts !== 'object' ||
        Array.isArray(frame.artifacts) ||
        !Object.hasOwn(frame.artifacts, 'result.json')
      )
        throw invalid()
      const artifacts = []
      for (const [name, encoded] of Object.entries(frame.artifacts)) {
        const limit = limits.get(name)
        if (
          !limit ||
          typeof encoded !== 'string' ||
          encoded.length > Math.ceil(limit / 3) * 4 ||
          encoded.length % 4 ||
          /[^A-Za-z0-9+/=]/.test(encoded)
        )
          throw invalid()
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.length > limit || bytes.toString('base64') !== encoded)
          throw invalid()
        artifacts.push([name, bytes])
      }
      const parent = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      try {
        if (
          (await fs.realpath(`/proc/self/fd/${parent.fd}`)) !==
          path.resolve(directory)
        )
          throw invalid()
        for (const [name, bytes] of artifacts) {
          const file = await fs.open(
            `/proc/self/fd/${parent.fd}/${name}`,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          )
          try {
            await file.writeFile(bytes)
          } finally {
            await file.close()
          }
        }
      } finally {
        await parent.close()
      }
      return rows
        .filter((row) => !row.startsWith(framePrefix))
        .join('\n')
        .slice(0, maxLog)
    },
  }
}
