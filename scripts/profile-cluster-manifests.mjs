#!/usr/bin/env node
// Reads immutable manifest objects only: no worker/controller, database or network.
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { BlobStore } from '../server/cluster/blobs.mjs'

const usage =
  'Usage: node scripts/profile-cluster-manifests.mjs --store /private/copied-store --hash SHA256 [--kind dependencies|toolchain|source|result] [--callers 8]'
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log(usage)
  process.exit(0)
}
if (!args.length || args.length % 2) throw new Error(usage)
const flags = new Map()
for (let i = 0; i < args.length; i += 2) {
  if (
    !['--store', '--hash', '--kind', '--callers'].includes(args[i]) ||
    flags.has(args[i])
  )
    throw new Error(usage)
  flags.set(args[i], args[i + 1])
}
const hash = flags.get('--hash')
const kind = flags.get('--kind') || 'dependencies'
const callers = Number(flags.get('--callers') || 8)
if (
  !flags.get('--store') ||
  !/^[a-f0-9]{64}$/.test(hash || '') ||
  !['dependencies', 'toolchain', 'source', 'result'].includes(kind) ||
  !Number.isInteger(callers) ||
  callers < 1 ||
  callers > 32
)
  throw new Error(usage)
const directory = await fs.realpath(path.resolve(flags.get('--store')))
// Deliberately do not init(): that would open storage budgets and source indexes.
const store = new BlobStore(directory)
let reads = 0
const read = store.read.bind(store)
store.read = (...values) => {
  reads++
  return read(...values)
}
const lag = monitorEventLoopDelay({ resolution: 10 })
lag.enable()
await delay(20)
const started = performance.now()
const values = await Promise.all(
  Array.from({ length: callers }, () => store.manifest(hash, kind)),
)
const coldMs = performance.now() - started
const coldReads = reads
const warmStarted = performance.now()
for (let i = 0; i < 30; i++) await store.manifest(hash, kind)
const warmThirtyMs = performance.now() - warmStarted
// Let the monitor record the final synchronous parse before disabling it.
await delay(20)
lag.disable()
const compiledFiles = Object.fromEntries(
  ['.olean', '.ilean', '.olean.private', '.olean.server', '.trace'].map(
    (ext) => [
      ext,
      values[0].entries.filter(
        (entry) => entry.type === 'file' && entry.path.endsWith(ext),
      ).length,
    ],
  ),
)
console.log(
  JSON.stringify(
    {
      kind,
      hash,
      concurrentCallers: callers,
      manifestBytes: (await fs.stat(path.join(directory, 'objects', hash)))
        .size,
      manifestEntries: values[0].entries.length,
      compiledFiles,
      coldReads,
      coldMs,
      sameVerifiedObject: values.every((value) => value === values[0]),
      warmReads: 30,
      warmThirtyMs,
      additionalWarmReads: reads - coldReads,
      encodedCacheBytes: store.manifestCacheBytes,
      cacheEntries: store.manifestCache.size,
      rssBytes: process.memoryUsage().rss,
      maxEventLoopDelayMs: lag.max / 1e6,
    },
    null,
    2,
  ),
)
