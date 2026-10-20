/* eslint-disable no-control-regex -- Strip terminal/control codes from untrusted display text and reject them in paths. */
import { MAX_TOOL_STEPS, mergeToolStep } from '../shared/tool-activity.mjs'

const tools = {
  lean_check: ['check', 'Check Lean code'],
  lean_check_target: ['check', 'Check a proof'],
  lean_run_code: ['check', 'Check Lean code'],
  lean_proof_state: ['read', 'Inspect proof goals'],
  lean_goal: ['read', 'Inspect proof goals'],
  lean_term_goal: ['read', 'Inspect the expected type'],
  lean_tactic: ['check', 'Try a tactic'],
  lean_multi_attempt: ['check', 'Try proof candidates'],
  lean_close_proof: ['check', 'Check the completed proof'],
  lean_diagnostic_messages: ['read', 'Read Lean diagnostics'],
  lean_hover_info: ['read', 'Inspect a declaration'],
  lean_local_search: ['search', 'Search project declarations'],
  lean_loogle: ['search', 'Search lemmas by type'],
  lean_leansearch: ['search', 'Search for lemmas'],
  lean_leanfinder: ['search', 'Search for lemmas'],
  lean_state_search: ['search', 'Search for a matching lemma'],
  lean_hammer_premise: ['search', 'Find useful lemmas'],
  lean_file_outline: ['read', 'Read the file outline'],
  lean_declaration_file: ['read', 'Find declaration source'],
  web_search_exa: ['search', 'Search the web'],
  web_fetch_exa: ['read', 'Read a web page'],
  tex_build: ['check', 'Compile LaTeX'],
}
const text = (value) => (typeof value === 'string' ? value : '')
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const credentialKey =
  /^(?:.*[_-])?(?:api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token)$/i

function projectPath(value) {
  const path = text(value)
    .replace(/^\/workspace\//, '')
    .replace(/^\.\//, '')
  return path &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/^[a-z][a-z\d+.-]*:/i.test(path) &&
    !path.split('/').some((part) => !part || part === '..' || part === '.') &&
    !/[\x00-\x1f]/.test(path)
    ? path
    : undefined
}

/** Keep structured activity separate from provider output and private RPC data. */
export function createAgentActivityHandler({
  events,
  id,
  redact = String,
  secrets = [],
}) {
  const clean = (value) => {
    let result = text(value)
    for (const secret of secrets.filter(
      (value) => typeof value === 'string' && value,
    ))
      result = result.split(secret).join('[redacted]')
    return (
      redact(result)
        // Display text only: remove terminal escapes and direction/control codes.
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,
          '',
        )
    )
  }
  const clip = (value, limit) => {
    const result = clean(value)
    return result.length <= limit
      ? result
      : result.slice(0, Math.floor(limit * 0.6)) +
          '\n… preview shortened …\n' +
          result.slice(-Math.floor(limit * 0.4))
  }
  const safeValue = (value, budget, depth = 0) => {
    if (--budget.remaining < 0) return '[preview limit]'
    if (typeof value === 'string') return clip(value, 4000)
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      return value
    if (depth > 5) return '[nested value omitted]'
    if (Array.isArray(value))
      return value
        .slice(0, 30)
        .map((item) => safeValue(item, budget, depth + 1))
    return Object.fromEntries(
      Object.entries(object(value))
        .slice(0, 40)
        .map(([key, item]) => [
          clean(key),
          credentialKey.test(key)
            ? '[redacted]'
            : safeValue(item, budget, depth + 1),
        ]),
    )
  }
  const preview = (value, limit) => {
    if (
      typeof value === 'string' &&
      value.length <= 64_000 &&
      /^\s*(?:\[|\{)/.test(value)
    ) {
      try {
        value = JSON.parse(value)
      } catch {
        /* Plain text remains plain text. */
      }
    }
    return clip(
      typeof value === 'string'
        ? value
        : JSON.stringify(safeValue(value, { remaining: 300 }), null, 2),
      limit,
    )
  }
  return {
    handle(method, item) {
      if (
        !['item/started', 'item/completed'].includes(method) ||
        !item ||
        typeof item.id !== 'string' ||
        item.id.length > 256 ||
        ![
          'commandExecution',
          'mcpToolCall',
          'fileChange',
          'dynamicToolCall',
          'webSearch',
        ].includes(item.type)
      )
        return false
      const job = events.getMetadata(id)
      const previous = job.toolActivity?.find((step) => step.id === item.id)
      // Repeated starts must not reopen a completed step.
      if (
        method === 'item/started' &&
        previous &&
        previous.status !== 'running'
      )
        return true
      const done = method === 'item/completed'
      const args = object(item.arguments)
      const tool = text(item.tool)
      const shortTool = tool.split('__').at(-1)
      let [kind, label] = (Object.hasOwn(tools, shortTool)
        ? tools[shortTool]
        : null) || ['tool', tool ? tool.replaceAll('_', ' ') : 'Use a tool']
      let detail = text(
        args.name ||
          args.query ||
          args.search_query ||
          args.file ||
          args.file_path ||
          args.path,
      )
      let input = item.arguments == null ? '' : preview(item.arguments, 1600)
      let path = projectPath(args.file || args.file_path || args.path)
      let output = ''
      let checkResult
      if (item.type === 'commandExecution') {
        const actions = Array.isArray(item.commandActions)
          ? item.commandActions
          : []
        const action = actions.length === 1 ? actions[0] : null
        const labels = {
          read: ['read', 'Read a file'],
          search: ['search', 'Search files'],
          listFiles: ['read', 'List files'],
        }
        ;[kind, label] = (Object.hasOwn(labels, action?.type)
          ? labels[action.type]
          : null) || ['command', 'Run a command']
        detail = text(action?.query || action?.path || item.command)
        path = projectPath(action?.path)
        input = clip(item.command, 1600)
        output = clip(item.aggregatedOutput, 4000)
      } else if (item.type === 'fileChange') {
        kind = 'edit'
        label = 'Edit working copy'
        const paths = (Array.isArray(item.changes) ? item.changes : [])
          .map((change) => text(change?.path))
          .filter(Boolean)
        detail = paths.join(', ')
        path = paths.length === 1 ? projectPath(paths[0]) : undefined
        input = clip(paths.join('\n'), 1600)
      } else if (item.type === 'webSearch') {
        kind = 'search'
        label = 'Search the web'
        detail = text(item.query || item.action?.query || item.action?.url)
        input = preview(item.action || { query: detail }, 1600)
      } else {
        if (item.server === 'lean_explore' && /search/.test(tool)) {
          kind = 'search'
          label = 'Search Lean declarations'
        }
        const content = item.result?.content || item.contentItems
        const parts = (Array.isArray(content) ? content : [])
          .filter(
            (part) =>
              ['text', 'inputText'].includes(part?.type) &&
              typeof part.text === 'string',
          )
          .slice(0, 8)
        const body = parts.map((part) => preview(part.text, 4000)).join('\n\n')
        let result = item.result?.structuredContent
        if (!result && parts[0]?.text.length <= 64_000) {
          try {
            result = JSON.parse(parts[0].text)
          } catch {
            /* Only explicit structured check evidence gets a result badge. */
          }
        }
        if (kind === 'check') {
          if (result?.ok === false) checkResult = 'issues'
          else if (result?.success === true && result.ok === true)
            checkResult = 'passed'
        }
        output = item.error
          ? preview(item.error, 4000)
          : body
            ? clip(body, 4000)
            : item.result?.structuredContent
              ? preview(item.result.structuredContent, 4000)
              : ''
      }
      const failed =
        item.status === 'failed' ||
        !!item.error ||
        item.success === false ||
        (Number.isInteger(item.exitCode) && item.exitCode !== 0)
      const status = !done
        ? 'running'
        : item.status === 'declined'
          ? 'declined'
          : failed
            ? 'failed'
            : item.status === 'completed' || Number.isInteger(item.exitCode)
              ? 'completed'
              : 'finished'
      const step = {
        ...(previous || {}),
        id: item.id,
        kind,
        label: clip(label, 100),
        detail: clip(detail, 200).replace(/\s+/g, ' '),
        ...(tool
          ? { tool: clip([item.server, tool].filter(Boolean).join(' / '), 140) }
          : {}),
        status,
        detailsOmitted: false,
        ...(checkResult ? { checkResult } : {}),
        messageOffset:
          previous?.messageOffset ??
          (job.messageBaseOffset || 0) + (job.message?.length || 0),
        afterFollowups:
          previous?.afterFollowups ?? (job.followups?.length || 0),
        startedAt: previous?.startedAt || new Date().toISOString(),
        ...(Number.isFinite(item.durationMs) && item.durationMs >= 0
          ? { durationMs: item.durationMs }
          : {}),
        ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
        ...(path
          ? {
              path: clean(path),
              line:
                Number.isSafeInteger(args.line) && args.line > 0
                  ? args.line
                  : 1,
            }
          : {}),
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
      }
      const steps = job.toolActivity || []
      const truncated =
        !!job.toolActivityTruncated ||
        (!previous && steps.length >= MAX_TOOL_STEPS)
      events.updateMetadata(id, {
        toolActivity: mergeToolStep(steps, step),
        toolActivityTruncated: truncated,
      })
      events.event(id, 'tool-step', step)
      return true
    },
  }
}
