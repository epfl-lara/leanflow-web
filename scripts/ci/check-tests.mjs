#!/usr/bin/env node
// Keep complete console output and expose failed test diagnostics as annotations.
import { spawn } from 'node:child_process'

const suites = [
  ['Application tests', 'npm', ['test']],
  [
    'Portable fixture tests',
    process.execPath,
    ['--test', 'scripts/ten-proofs-fixture.test.mjs'],
  ],
]

for (const [name, command, args] of suites) {
  let tail = ''
  const record = (chunk, destination) => {
    destination.write(chunk)
    tail = (tail + chunk).slice(-32 * 1024)
  }
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout
    .setEncoding('utf8')
    .on('data', (chunk) => record(chunk, process.stdout))
  child.stderr
    .setEncoding('utf8')
    .on('data', (chunk) => record(chunk, process.stderr))
  const code = await new Promise((resolve) => {
    child.once('error', (error) => {
      tail = error.message
      resolve(1)
    })
    child.once('close', (status) => resolve(status ?? 1))
  })
  if (code !== 0) {
    // GitHub truncates large annotations. Stay below its message limit and
    // per-step annotation count so the final assertion remains accessible.
    const diagnostics = (
      tail || 'The test process exited without diagnostics.'
    ).slice(-24000)
    for (let offset = 0; offset < diagnostics.length; offset += 3000) {
      const message = diagnostics
        .slice(offset, offset + 3000)
        .replaceAll('%', '%25')
        .replaceAll('\r', '%0D')
        .replaceAll('\n', '%0A')
      console.error(`::error title=${name} failed::${message}`)
    }
    process.exitCode = code
    break
  }
}
