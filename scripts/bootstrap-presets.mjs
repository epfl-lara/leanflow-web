#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../server/runtime.mjs'

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const dataDir = path.resolve(
  process.env.STUDIO_DATA_DIR ||
    process.env.LEMEX_WEB_DATA ||
    path.join(projectDir, '.data'),
)
const runtime = new Runtime({
  dataDir,
  maxConcurrent: 2,
  memory: '8g',
  cpus: 4,
  pidsLimit: 1024,
})
let shutdown
const stop = () => {
  shutdown ||= runtime.shutdown()
  return shutdown
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
try {
  await runtime.init()
  if (!runtime.info().ready) throw new Error(runtime.info().error)
  try {
    await runtime.leanReleases.refresh(
      runtime.presetInstaller.controller.signal,
    )
  } catch (error) {
    console.warn(`Using cached Lean releases: ${error.message}`)
  }
  if (!runtime.stopping) {
    const { failures } = await runtime.presetInstaller.prepareAll({
      ids: process.argv.slice(2),
      onProgress: (id, message) => console.log(`${id}: ${message}`),
    })
    if (failures) process.exitCode = 1
  }
} finally {
  await stop()
}
