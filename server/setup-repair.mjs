import * as fs from 'node:fs/promises'
import path from 'node:path'
import { AgentRpc } from './rpc.mjs'
import { createAgentOutputHandler } from './agent-output.mjs'

// A setup turn works only on a disposable project copy. WorkspaceStore admits
// configuration changes and retries normal environment checks afterwards.
export async function repairProjectSetup({
  runtime,
  config,
  root,
  project,
  error,
  signal,
  onOutput = () => {},
}) {
  if (!config.provider.LEMEX_API_KEY)
    throw new Error(
      'Automatic setup repair needs the server Lemex provider key. The uploaded files are retained.',
    )
  signal?.throwIfAborted()
  const home = await runtime.home(root)
  await fs.writeFile(
    path.join(home, '.lemex/config.toml'),
    [
      'model_provider = "rcp"',
      `model = ${JSON.stringify(config.defaultModel)}`,
      'model_catalog_json = "models.json"',
      'web_search = "disabled"',
      '[analytics]',
      'enabled = false',
      '[feedback]',
      'enabled = false',
    ].join('\n') + '\n',
    { mode: 0o600 },
  )
  const child = runtime.spawn(
    root,
    ['lemex', 'app-server', '--stdio', '--strict-config'],
    { env: config.provider, network: 'bridge', signal },
  )
  const closed = new Promise((resolve) => {
    child.once('close', resolve)
    child.once('error', resolve)
  })
  const rpc = new AgentRpc(child)
  const log = (text) => onOutput(config.redact(String(text)))
  const output = createAgentOutputHandler({
    append: (_field, text) => log(text),
    redact: config.redact,
    secrets: [config.provider.LEMEX_API_KEY],
    showReasoning: false,
  })
  let resolveFinished, rejectFinished
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })
  finished.catch(() => {})
  rpc.on('closed', rejectFinished)
  child.stderr.on('data', (value) => {
    if (/ERROR|failed|error:/i.test(value.toString()))
      log(value.toString().slice(0, 2000))
  })
  rpc.on('request', (request) => {
    try {
      if (/requestApproval$/.test(request.method))
        rpc.respond(request.id, { decision: 'decline' })
      else if (request.method === 'item/tool/requestUserInput')
        rpc.respond(request.id, { answers: {} })
      else
        rpc.send({
          id: request.id,
          error: {
            code: -32601,
            message:
              'Interactive requests are unavailable during automatic setup repair.',
          },
        })
    } catch {}
  })
  rpc.on('notification', ({ method, params }) => {
    if (output.handle(method, params)) return
    if (method === 'item/started' && params.item?.type === 'commandExecution')
      log(
        `Setup repair: ${String(params.item.command || 'checking project configuration').slice(0, 500)}\n`,
      )
    if (method === 'turn/completed') {
      output.flush()
      resolveFinished(params.turn)
    }
  })
  try {
    await rpc.call('initialize', {
      clientInfo: {
        name: 'lemex_web_setup',
        title: 'Lemex project setup',
        version: '0.1.0',
      },
    })
    rpc.notify('initialized')
    const { thread } = await rpc.call('thread/start', {
      model: config.defaultModel,
      cwd: '/workspace',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: true,
      developerInstructions:
        'Repair the setup of this Lean project. You are in an isolated copy. Only changes to the root lean-toolchain, lakefile.toml, lakefile.lean and lake-manifest.json can be accepted. Do not change, delete, or weaken proof source files or theorem statements. Preserve an existing pinned Lean version and dependency revisions unless they are demonstrably invalid. If lean-toolchain is missing, infer it from existing dependency manifests or documented requirements; use the suggested release only if there is no stronger project evidence. Diagnose the supplied error, make the smallest configuration fix, and validate with lake env lean --version when possible. Ordinary unfinished proofs are not setup failures. Do not edit .git or credentials. Explain what was changed and any unresolved problem. Do not claim success from a tool result you did not run.',
    })
    signal?.throwIfAborted()
    await rpc.call('turn/start', {
      threadId: thread.id,
      input: [
        {
          type: 'text',
          textElements: [],
          text: `Project: ${project.name}\nSuggested fallback toolchain: ${project.toolchain || 'Infer from project requirements'}\nAutomatic setup failed:\n${String(error).slice(-12000)}\n\nRepair this setup while preserving all proof sources.`,
        },
      ],
    })
    const result = await finished
    if (result.status !== 'completed')
      throw new Error(result.error?.message || `Setup repair ${result.status}.`)
  } finally {
    output.flush()
    rpc.close()
    await closed
  }
}
