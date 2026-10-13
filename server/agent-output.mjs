// App-server supplies public plaintext reasoning separately from assistant text.
// Never decode encrypted reasoning or substitute a summary for unavailable text.
const fields = { message: 'message', reasoning: 'reasoning', reasoningSummary: 'reasoning-summary' }
const modernDeltas = {
  'item/agentMessage/delta': ['message', 'contentIndex'],
  'item/reasoning/textDelta': ['reasoning', 'contentIndex'],
  'item/reasoning/summaryTextDelta': ['reasoningSummary', 'summaryIndex'],
}
const legacyNames = {
  agent_reasoning_delta: ['reasoningSummary', true],
  agent_reasoning_raw_content_delta: ['reasoning', true],
  agent_reasoning: ['reasoningSummary', false],
  agent_reasoning_raw_content: ['reasoning', false],
  reasoning_content_delta: ['reasoningSummary', true],
  reasoning_raw_content_delta: ['reasoning', true],
}
function plaintext(value, type) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return ['text', type].includes(value.type) && typeof value.text === 'string' ? value.text : ''
}

export function createAgentOutputHandler({ append, redact = String, showReasoning = true, secrets = [], limit = 250_000, flushIntervalMs = 250 }) {
  const states = new Map(), channels = new Map(), modern = new Set()
  const knownSecrets = [...new Set(secrets.filter(value => typeof value === 'string' && value.length))]
  const tailLength = Math.max(0, ...knownSecrets.map(value => value.length - 1))
  let timer = null
  const channel = field => {
    if (!channels.has(field)) channels.set(field, { pending: '', buffered: '', written: 0, part: null })
    return channels.get(field)
  }
  function drain(field) {
    const output = channel(field), text = output.buffered
    output.buffered = ''
    for (let index = 0; index < text.length; index += 16_000) append(field, text.slice(index, index + 16_000), fields[field])
  }
  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      for (const field of channels.keys()) drain(field)
    }, flushIntervalMs)
    timer.unref?.()
  }
  function publish(field, final = false) {
    const output = channel(field)
    let boundary = final ? output.pending.length : Math.max(0, output.pending.length - tailLength)
    // A secret crossing the boundary must be redacted as one complete string.
    for (const secret of knownSecrets) {
      let index = output.pending.indexOf(secret)
      while (index >= 0) {
        if (index < boundary && index + secret.length > boundary) boundary = index + secret.length
        index = output.pending.indexOf(secret, index + secret.length)
      }
    }
    if (!boundary) return
    let text = output.pending.slice(0, boundary)
    output.pending = output.pending.slice(boundary)
    for (const secret of knownSecrets) text = text.split(secret).join('[redacted]')
    text = redact(text).slice(0, Math.max(0, limit - output.written))
    output.written += text.length
    output.buffered += text
    if (text) schedule()
  }
  function write(field, itemId, index, text, delta) {
    if (!text || (field === 'reasoning' && !showReasoning)) return
    const output = channel(field)
    if (output.written >= limit) return
    const key = `${field}:${String(itemId)}:${index}`
    if (!states.has(key)) {
      // Keep memory bounded independently of the persisted output bound.
      if (states.size >= 4096) return
      states.set(key, { streamed: false, full: '' })
    }
    const state = states.get(key)
    if (delta) state.streamed = true
    else {
      if (state.streamed || text === state.full) return
      if (state.full && !text.startsWith(state.full)) return
      const previous = state.full.length
      state.full = text.slice(0, limit)
      text = text.slice(previous)
      if (!text) return
    }
    if (field !== 'message' && output.part !== null && output.part !== key) output.pending += '\n\n'
    output.part = key
    output.pending += text.slice(0, limit)
    publish(field)
  }
  function itemOutput(item, method) {
    const id = item.id ?? item.itemId ?? 'unknown'
    if (item.type === 'agentMessage') {
      modern.add('message')
      write('message', id, 0, plaintext(item.text, 'text'), false)
      if (method === 'item/completed') { publish('message', true); drain('message') }
      return true
    }
    if (item.type !== 'reasoning') return false
    modern.add('reasoning'); modern.add('reasoningSummary')
    const summary = item.summary ?? item.summaryText ?? item.summary_text ?? []
    const content = item.content ?? item.publicReasoningContent ?? item.rawContent ?? item.raw_content ?? []
    for (const [field, parts, type] of [['reasoningSummary', summary, 'summary_text'], ['reasoning', content, 'reasoning_text']]) {
      const list = Array.isArray(parts) ? parts : [parts]
      list.forEach((part, index) => write(field, id, index, plaintext(part, type), false))
      if (method === 'item/completed') { publish(field, true); drain(field) }
    }
    return true
  }
  return {
    handle(method, params = {}) {
      const delta = modernDeltas[method]
      if (delta) {
        const [field, index] = delta
        modern.add(field)
        write(field, params.itemId ?? params.item_id ?? 'unknown', params[index] ?? 0, plaintext(params.delta, 'text'), true)
        return true
      }
      if (method === 'item/reasoning/summaryPartAdded') return true
      if (method === 'item/started' || method === 'item/completed') return itemOutput(params.item || {}, method)
      const legacy = legacyNames[method.replace(/^codex\/event\//, '')]
      if (legacy) {
        const [field, delta] = legacy, value = params.msg || params
        if (!modern.has(field)) write(field, value.itemId ?? value.item_id ?? 'legacy', value.summaryIndex ?? value.summary_index ?? value.contentIndex ?? value.content_index ?? 0, plaintext(delta ? value.delta : value.text, 'text'), delta)
        if (!delta) { publish(field, true); drain(field) }
        return true
      }
      return false
    },
    flush() {
      clearTimeout(timer); timer = null
      for (const field of channels.keys()) { publish(field, true); drain(field) }
      clearTimeout(timer); timer = null
    },
  }
}
