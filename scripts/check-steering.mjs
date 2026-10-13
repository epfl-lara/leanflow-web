#!/usr/bin/env node
// Isolated, real-provider smoke: never connects to the running web service.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../server/runtime.mjs'
import { loadConfig } from '../server/config.mjs'
import { createStudio } from '../server/studio.mjs'

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const dataDir = path.join(
  projectDir,
  '.runtime',
  'steering-check-' + Date.now(),
)
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
await fs.copyFile(
  path.join(projectDir, '.data/provider.json'),
  path.join(dataDir, 'provider.json'),
)
await fs.chmod(path.join(dataDir, 'provider.json'), 0o600)
const config = await loadConfig(dataDir)
assert(
  config.provider.LEMEX_API_KEY,
  'A configured provider is required for this explicit smoke test.',
)
const model = config.models.find((model) => model.id === config.defaultModel)
const effort =
  model.reasoningEfforts.find((level) => level.id === 'low')?.id ||
  model.defaultReasoningEffort
const runtime = new Runtime({
  dataDir,
  image:
    process.env.STUDIO_SMOKE_IMAGE || 'lemex-web-worker:lean-probe-646cb0ee',
  scope: 'helper',
})
const native = { starts: [], steering: [], probes: [] }
const originalSpawn = runtime.spawn.bind(runtime)
const guidance =
  'Keep the exact theorem statement. Use LeanProbe lean_check_target with replacement `by exact Nat.add_comm a b`, then require success=true and ok=true before applying the repair.'
runtime.spawn = (root, args, options) => {
  const child = originalSpawn(root, args, options)
  if (args[0] !== 'lemex') return child
  let buffered = ''
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString()
    let end
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      try {
        const packet = JSON.parse(line),
          item = packet.params?.item
        if (
          packet.method === 'item/completed' &&
          item?.type === 'mcpToolCall' &&
          item.server === 'lean_probe'
        )
          native.probes.push(JSON.parse(config.redact(JSON.stringify(item))))
      } catch {}
    }
  })
  const write = child.stdin.write.bind(child.stdin)
  child.stdin.write = (chunk, ...rest) => {
    try {
      const packet = JSON.parse(String(chunk))
      if (packet.method === 'turn/start')
        native.starts.push({
          effort: packet.params.effort ?? null,
          continuedGuidance: JSON.stringify(packet.params.input).includes(
            guidance,
          ),
          threadId: packet.params.threadId,
        })
      if (packet.method === 'turn/steer')
        native.steering.push({
          expectedTurnId: packet.params.expectedTurnId,
          clientUserMessageId: packet.params.clientUserMessageId,
        })
    } catch {}
    return write(chunk, ...rest)
  }
  return child
}
let studio, first, second
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
async function until(read, predicate, ms = 600_000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const value = read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    'Smoke watchdog expired; only this isolated fixture will be stopped.',
  )
}
async function save(report) {
  await fs.writeFile(
    path.join(dataDir, 'result.json'),
    config.redact(
      JSON.stringify(
        { catalogDefaultEffort: model.defaultReasoningEffort, ...report },
        null,
        2,
      ),
    ),
    { mode: 0o600 },
  )
}
try {
  studio = await createStudio({ dataDir, runtime, config })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  await studio.settings.save('owner', {
    extraInstructions: '',
    showReasoning: true,
    tools: { lean: true, lean_probe: true, lean_explore: false, exa: false },
  })
  const project = await studio.workspaces.create('owner', {
    name: 'Native steering and LeanProbe smoke',
    preset: 'lean',
    autoRepair: false,
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  const broken =
    'import Lean\n\ntheorem addition_commutes (a b : Nat) : a + b = b + a := by\n  exact Nat.add_assoc a b 0\n'
  const before = await studio.workspaces.readFile(
    project.id,
    'owner',
    'Main.lean',
  )
  await studio.workspaces.writeFile(
    project.id,
    'owner',
    'Main.lean',
    broken,
    before.hash,
  )
  const chat = studio.chats.create('owner', project.id, {
    title: 'Native steering smoke',
  })
  first = await studio.agents.start('owner', project.id, {
    mode: 'proofs',
    prompt:
      'This is a small steering smoke test. First run `sleep 20` as a shell command, before editing files or checking proofs, to give the user a chance to send guidance. Then repair Main.lean. Keep the theorem statement and imports. Do not ask a question.',
    files: ['Main.lean'],
    file: 'Main.lean',
    chatId: chat.id,
    effort,
    maxSeconds: null,
    liveEdits: true,
  })
  console.log(
    'Isolated native fixture started',
    dataDir,
    'first run',
    first.id,
    'effort',
    effort,
  )
  await until(
    () => studio.agents.active.get(first.id),
    (active) => active?.accepting === true,
    180_000,
  )
  const message = { id: randomUUID(), text: guidance, files: ['Main.lean'] }
  const accepted = await studio.agents.message('owner', first.id, message)
  assert.equal(
    accepted.followups[0].status,
    'accepted',
    accepted.followups[0].error,
  )
  await studio.agents.message('owner', first.id, message)
  assert.equal(
    native.steering.length,
    1,
    'Retrying the same receipt must not send a second native request',
  )
  console.log(
    'Native same-turn guidance acknowledged exactly once; stopping fixture',
  )
  const stopped = await studio.agents.stop('owner', first.id)
  assert.equal(stopped.status, 'cancelled')
  assert(
    !studio.agents.active.has(first.id),
    'Stop must wait until native and mirror teardown completes',
  )
  assert(
    studio.events
      .events(first.id)
      .some(
        (event) => event.type === 'status' && event.data.status === 'stopping',
      ),
  )
  const saved = await studio.workspaces.readFile(
    project.id,
    'owner',
    'Main.lean',
  )
  if (saved.content !== broken)
    await studio.workspaces.writeFile(
      project.id,
      'owner',
      'Main.lean',
      broken,
      saved.hash,
    )
  second = await studio.agents.start('owner', project.id, {
    mode: 'proofs',
    prompt:
      'Continue this chat and repair the proof in Main.lean now. Call the enabled lean_probe MCP lean_check_target tool on the addition_commutes declaration with replacement `by exact Nat.add_comm a b` before editing; inspect success=true and ok=true. Then save that repair in Main.lean and check it. Keep the exact theorem statement and imports. Do not run sleep. Finish with one short sentence.',
    files: ['Main.lean'],
    file: 'Main.lean',
    chatId: chat.id,
    effort,
    maxSeconds: null,
    liveEdits: true,
  })
  console.log('Continuation started', second.id)
  let label = ''
  const result = await until(
    () => studio.events.get(second.id),
    (job) => {
      if (job.progress?.label !== label) {
        label = job.progress?.label
        console.log('Fixture progress:', label)
      }
      return terminal.has(job.status)
    },
  )
  const final = await studio.workspaces.readFile(
    project.id,
    'owner',
    'Main.lean',
  )
  await save({
    ok: false,
    dataDir,
    projectId: project.id,
    chatId: chat.id,
    runtime: runtime.info(),
    model: config.defaultModel,
    effort,
    native,
    stopped,
    result,
    final,
  })
  assert.equal(result.status, 'completed', result.error)
  assert.equal(
    result.verification?.complete,
    true,
    JSON.stringify(result.verification),
  )
  assert.equal(result.verification?.kernelChecked, true)
  assert(final.content.includes('Nat.add_comm a b'))
  assert(
    native.starts[1]?.continuedGuidance,
    'The new fresh native thread must retain acknowledged chat guidance as user context',
  )
  assert(native.starts.every((start) => start.effort === effort))
  native.turnContexts = []
  for await (const filename of fs.glob(
    'runtime/homes/*/.lemex/sessions/**/*.jsonl',
    { cwd: dataDir },
  )) {
    const lines = (
      await fs.readFile(path.join(dataDir, filename), 'utf8')
    ).split('\n')
    for (const line of lines) {
      try {
        const packet = JSON.parse(line)
        if (packet.type === 'turn_context')
          native.turnContexts.push({
            model: packet.payload.model,
            effort: packet.payload.effort,
          })
      } catch {}
    }
  }
  assert(
    native.turnContexts.some(
      (context) =>
        context.effort === effort && context.model === config.defaultModel,
    ),
    'Native persisted turn context must confirm the selected effort',
  )
  const successfulProbe = native.probes.find(
    (item) =>
      item.tool === 'lean_check_target' &&
      !item.error &&
      item.result?.structuredContent?.success === true &&
      item.result?.structuredContent?.ok === true,
  )
  assert(
    successfulProbe,
    'Require an actual successful LeanProbe target invocation, not just a configured tool',
  )
  await save({
    ok: true,
    dataDir,
    projectId: project.id,
    chatId: chat.id,
    runtime: runtime.info(),
    model: config.defaultModel,
    effort,
    native,
    stopped,
    result,
    final,
  })
  console.log(
    'PASS native steering, clean Stop, continuation, LeanProbe, live repair, independent kernel verification',
    path.join(dataDir, 'result.json'),
  )
} catch (error) {
  await save({
    ok: false,
    dataDir,
    error: error.message,
    native,
    first: first && studio?.events.get(first.id),
    second: second && studio?.events.get(second.id),
  })
  throw error
} finally {
  await studio?.close()
  if (!studio) await runtime.shutdown()
}
