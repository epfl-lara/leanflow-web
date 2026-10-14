import { writeModelCatalog } from './model-catalog.mjs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { AgentRpc } from './rpc.mjs'
import { createAgentOutputHandler } from './agent-output.mjs'

export async function withSetupRepairDeadline(
  execute,
  { signal, timeoutMs = 900000 } = {},
) {
  const controller = new AbortController()
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          'Lemex setup repair reached its time limit. Your source files are preserved. Retry setup or inspect the setup output.',
        ),
      ),
    timeoutMs,
  )
  try {
    combined.throwIfAborted()
    const result = await execute(combined)
    combined.throwIfAborted()
    return result
  } catch (error) {
    if (combined.aborted && !error?.workerCleanup) throw combined.reason
    throw error
  } finally {
    clearTimeout(timer)
  }
}

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
  onActivity = () => {},
}) {
  if (!config.provider.LEMEX_API_KEY)
    throw new Error(
      'Automatic setup repair needs the server Lemex provider key. The uploaded files are retained.',
    )
  signal?.throwIfAborted()
  const model = config.models?.find((model) => model.id === config.defaultModel)
  const effort = model?.defaultReasoningEffort
  if (effort && !model.reasoningEfforts?.some((level) => level.id === effort))
    throw new Error(
      'The configured setup model has an unsupported reasoning effort.',
    )
  const home = await runtime.home(root)
  await writeModelCatalog(home, config.modelCatalog)
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
  const child = await runtime.spawnWhenAvailable(
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
    if (method === 'item/started' && params.item?.type === 'commandExecution') {
      const command = String(params.item.command || '')
      onActivity(
        /cache.*get/.test(command)
          ? 'Fetching compiled library files'
          : /lake.*(?:build|lean)/.test(command)
            ? 'Testing the Lean environment'
            : /git/.test(command)
              ? 'Checking pinned dependency revisions'
              : 'Inspecting project configuration',
      )
      log(
        `Setup repair: ${String(params.item.command || 'checking project configuration').slice(0, 500)}\n`,
      )
    }
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
        'Repair the setup of this Lean project. You are in an isolated copy. Only changes to the root lean-toolchain, lakefile.toml, lakefile.lean and lake-manifest.json can be accepted. Do not change, delete, or weaken proof source files or theorem statements. Preserve every existing valid pinned Lean release and resolved Git dependency revision. Do not switch versions to work around missing compiled artifacts. If lean-toolchain is missing, infer it from existing dependency manifests or documented requirements; use the suggested release only if there is no stronger project evidence. Diagnose the supplied error and make the smallest configuration fix. Run lake env lean --version; when the project uses Mathlib, run lake exe cache get and check a separate small proof importing Mathlib with lake env lean --stdin. Test the environment independently of unfinished user proofs. If the environment works without configuration edits, report that and let setup retry the original project; do not make unnecessary edits. Do not edit .git or credentials. Explain what was changed and any unresolved problem. Do not claim success from a tool result you did not run.',
    })
    signal?.throwIfAborted()
    await rpc.call('turn/start', {
      threadId: thread.id,
      ...(effort ? { effort } : {}),
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
