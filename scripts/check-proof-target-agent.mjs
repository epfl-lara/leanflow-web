#!/usr/bin/env node
// Explicit real-provider smoke: runs one Lemex task using the configured provider.
// Requires a configured self-hosted installation, Docker worker image, and Lean
// toolchain. Uses only a new private fixture; never calls the production server.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
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
  'proof-target-agent-' + Date.now(),
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
const selectedModel = config.models.find(
  (model) => model.id === config.defaultModel,
)
assert(selectedModel, 'The configured default model must be in the catalog.')
const effort =
  selectedModel.reasoningEfforts.find((level) => level.id === 'low')?.id ||
  selectedModel.defaultReasoningEffort
const runtime = new Runtime({
  dataDir,
  image:
    process.env.STUDIO_SMOKE_IMAGE ||
    process.env.LEMEX_WORKER_IMAGE ||
    'lemex-web-worker:local',
  scope: 'helper',
})
const prefix =
  'import Lean\n\n-- This unrelated theorem must stay byte-for-byte unchanged.\ntheorem untouched (n : Nat) : n = n := by\n  rfl\n\n'
const statement = 'theorem focused_addition (a b : Nat) : a + b = b + a := by'
const source = statement + '\n  exact Nat.add_assoc a b 0'
const suffix = '\n\n-- End of the original file.\n'
const before = prefix + source + suffix
const startLine = prefix.split('\n').length
const proofTarget = {
  path: 'Main.lean',
  startLine,
  endLine: startLine + 1,
  name: 'focused_addition',
  source,
}
const native = { starts: [], turnContexts: [] }
const originalSpawn = runtime.spawn.bind(runtime)
runtime.spawn = (root, args, options) => {
  const child = originalSpawn(root, args, options)
  if (args[0] !== 'lemex') return child
  const write = child.stdin.write.bind(child.stdin)
  child.stdin.write = (chunk, ...rest) => {
    try {
      const packet = JSON.parse(String(chunk))
      if (packet.method === 'turn/start') {
        const text = packet.params.input
          .map((item) => item.text || '')
          .join('\n')
        native.starts.push({
          effort: packet.params.effort ?? null,
          exactTargetContext: text.includes(JSON.stringify(proofTarget)),
          userInput: packet.params.input,
        })
      }
    } catch {}
    return write(chunk, ...rest)
  }
  return child
}
let studio, project, chat, run
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
async function report(fields) {
  await fs.writeFile(
    path.join(dataDir, 'result.json'),
    config.redact(
      JSON.stringify(
        {
          dataDir,
          model: config.defaultModel,
          effort,
          proofTarget,
          native,
          projectId: project?.id,
          chatId: chat?.id,
          runId: run?.id,
          runtime: runtime.info(),
          ...fields,
        },
        null,
        2,
      ),
    ),
    { mode: 0o600 },
  )
}
try {
  studio = await createStudio({
    dataDir,
    runtime,
    config,
    titleGenerator: async () => 'Proof focus smoke',
  })
  await studio.settings.save('owner', {
    extraInstructions: '',
    showReasoning: true,
    tools: { lean: true, lean_probe: true, lean_explore: false, exa: false },
  })
  project = await studio.workspaces.create('owner', {
    name: 'Isolated proof focus smoke',
    preset: 'lean',
    autoRepair: false,
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  const original = await studio.workspaces.readFile(
    project.id,
    'owner',
    'Main.lean',
  )
  await studio.workspaces.writeFile(
    project.id,
    'owner',
    'Main.lean',
    before,
    original.hash,
  )
  chat = studio.chats.create('owner', project.id, {
    title: 'Proof focus smoke',
  })
  run = await studio.agents.start('owner', project.id, {
    mode: 'proofs',
    prompt:
      'Repair only the selected proof. Preserve its exact theorem statement and all text outside the selected proof byte-for-byte, including the unrelated theorem and comments. Nat.add_comm a b is the useful lemma. Save and check the proof. Finish with one short sentence.',
    proofTarget,
    chatId: chat.id,
    effort,
    maxSeconds: null,
    liveEdits: true,
  })
  console.log(
    'Isolated proof focus provider smoke:',
    dataDir,
    'model:',
    config.defaultModel,
    'effort:',
    effort,
  )
  const started = Date.now()
  let result, progress
  while (true) {
    result = studio.events.get(run.id)
    if (result.progress?.label !== progress) {
      progress = result.progress?.label
      console.log('Fixture progress:', progress)
    }
    if (terminal.has(result.status)) break
    if (Date.now() - started > 600_000)
      throw new Error(
        'The 10-minute QA watchdog expired; only this isolated fixture will be stopped.',
      )
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const final = await studio.workspaces.readFile(
    project.id,
    'owner',
    'Main.lean',
  )
  for await (const filename of fs.glob(
    'runtime/homes/*/.lemex/sessions/**/*.jsonl',
    { cwd: dataDir },
  )) {
    for (const line of (
      await fs.readFile(path.join(dataDir, filename), 'utf8')
    ).split('\n')) {
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
  await report({ ok: false, result, final })
  assert.equal(result.status, 'completed', result.error)
  assert.equal(
    result.verification?.complete,
    true,
    JSON.stringify(result.verification),
  )
  assert.equal(result.verification?.kernelChecked, true)
  assert.equal(
    native.starts.length,
    1,
    'Only one native proof task should start',
  )
  assert.equal(
    native.starts[0].exactTargetContext,
    true,
    'Native input must contain the exact target metadata and source',
  )
  assert.equal(native.starts[0].effort, effort)
  assert(
    native.turnContexts.some(
      (context) =>
        context.model === config.defaultModel && context.effort === effort,
    ),
    'Native persisted context must confirm selected model and effort',
  )
  assert(
    final.content.startsWith(prefix),
    'The unrelated theorem and preceding text must be unchanged',
  )
  assert(
    final.content.endsWith(suffix),
    'Text after the selected proof must be unchanged',
  )
  assert(
    final.content.includes(statement),
    'The selected theorem statement must be unchanged',
  )
  assert.notEqual(
    final.content,
    before,
    'The selected proof must have been repaired live',
  )
  await report({ ok: true, result, final, unrelatedTextUnchanged: true })
  console.log(
    'PASS focused live repair, unchanged unrelated theorem, independent Lean/kernel verification:',
    path.join(dataDir, 'result.json'),
  )
  console.log('Measured usage:', JSON.stringify(result.usage || null))
} catch (error) {
  await report({
    ok: false,
    error: error.message,
    result: run && studio?.events.get(run.id),
  })
  throw error
} finally {
  await studio?.close()
  if (!studio) await runtime.shutdown()
}
