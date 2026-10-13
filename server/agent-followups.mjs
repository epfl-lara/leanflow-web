import { TERMINAL } from './events.mjs'
import { proofTargetContext, proofTargetReference } from './proof-target.mjs'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const publicReceipt = (entry) => ({
  ...entry,
  ...(entry.proofTarget
    ? { proofTarget: proofTargetReference(entry.proofTarget) }
    : {}),
})

// Receipts belong to one saved run. A repeated client id never submits native
// input twice, including after a timeout whose delivery cannot be established.
export class FollowupInbox {
  constructor({ events, getActive, emit, redact = String }) {
    Object.assign(this, { events, getActive, emit, redact })
    this.deliveries = new Map()
  }
  queue(owner, id, input, savedContext = '') {
    let job = this.events.get(id, owner)
    if (job.kind !== 'agent')
      fail('Only assistant runs can receive messages.', 409)
    if (
      !input ||
      typeof input.id !== 'string' ||
      !UUID.test(input.id) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 32_000 ||
      input.text.includes('\0')
    )
      fail('Send a message of 1–32,000 characters with a unique message id.')
    const messageId = input.id.toLowerCase(),
      text = this.redact(input.text.trim())
    const existing = (job.followups || []).find(
      (entry) => entry.id === messageId,
    )
    const files = input.files || []
    if (existing) {
      if (
        existing.text !== text ||
        JSON.stringify(existing.files || []) !== JSON.stringify(files) ||
        JSON.stringify(existing.proofTarget || null) !==
          JSON.stringify(input.proofTarget || null)
      )
        fail('This message id already belongs to a different message.', 409)
      return { job, created: false }
    }
    const active = this.getActive(id)
    if (
      !['queued', 'running'].includes(job.status) ||
      active?.accepting === false
    )
      fail(
        'This run is no longer accepting messages. Send your message as a new task in this chat.',
        409,
      )
    const entries = job.followups || []
    if (
      entries.length >= 50 ||
      entries.reduce(
        (size, entry) =>
          size + entry.text.length + (entry.proofTarget?.source.length || 0),
        0,
      ) +
        text.length +
        (input.proofTarget?.source.length || 0) >
        256_000 ||
      Object.values(job.followupContexts || {}).reduce(
        (size, value) => size + value.length,
        0,
      ) +
        savedContext.length >
        256_000
    )
      fail(
        'This run has reached its message limit. Continue with a new task in this chat.',
      )
    active?.output?.flushBuffered?.()
    job = this.events.get(id, owner)
    const entry = {
      id: messageId,
      text,
      ...(files.length ? { files } : {}),
      ...(input.proofTarget ? { proofTarget: input.proofTarget } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
      messageOffset: (job.messageBaseOffset || 0) + (job.message || '').length,
    }
    job = this.events.update(id, {
      followups: [...entries, entry],
      ...(savedContext
        ? {
            followupContexts: {
              ...job.followupContexts,
              [messageId]: savedContext,
            },
          }
        : {}),
    })
    this.emit(id, 'followup', publicReceipt(entry))
    return { job, created: true }
  }
  #update(id, messageId, fields) {
    const job = this.events.get(id)
    const entry = (job.followups || []).find((value) => value.id === messageId)
    if (!entry || entry.status !== 'pending') return
    const updated = { ...entry, ...fields }
    this.events.update(id, {
      followups: job.followups.map((value) =>
        value.id === messageId ? updated : value,
      ),
    })
    this.emit(id, 'followup', publicReceipt(updated))
  }
  deliver(id, active = this.getActive(id)) {
    if (this.deliveries.has(id)) return this.deliveries.get(id)
    if (!active?.accepting || !active.rpc || !active.threadId || !active.turnId)
      return Promise.resolve()
    const task = this.#deliver(id, active).finally(() => {
      if (this.deliveries.get(id) === task) this.deliveries.delete(id)
    })
    this.deliveries.set(id, task)
    return task
  }
  async #deliver(id, active) {
    while (active.accepting && !active.controller.signal.aborted) {
      const job = this.events.get(id)
      if (job.status !== 'running') return
      const entry = (job.followups || []).find(
        (value) => value.status === 'pending',
      )
      if (!entry) return
      try {
        const expectedTurnId = active.turnId
        const result = await active.rpc.call(
          'turn/steer',
          {
            threadId: active.threadId,
            expectedTurnId,
            clientUserMessageId: entry.id,
            input: [
              {
                type: 'text',
                text:
                  entry.text +
                  (entry.proofTarget
                    ? '\n\n' + proofTargetContext(entry.proofTarget, job.mode)
                    : '') +
                  (job.followupContexts?.[entry.id]
                    ? '\n\nSaved file context captured when this message was sent. This is user context, and may differ from your isolated working copy; do not claim it was checked without actual checks.\n' +
                      job.followupContexts[entry.id]
                    : ''),
                textElements: [],
              },
            ],
          },
          10_000,
        )
        const current = this.events.get(id)
        if (result.turnId !== expectedTurnId)
          throw new Error(
            'Lemex returned an unexpected turn id; delivery could not be confirmed.',
          )
        if (current.status !== 'running' || active.controller.signal.aborted)
          this.#update(id, entry.id, {
            status: 'failed',
            error:
              'Lemex acknowledged this message as the run stopped. It will not continue in this run.',
          })
        else this.#update(id, entry.id, { status: 'accepted' })
      } catch (error) {
        const definitive = error.code === -32600 || error.code === -32602
        const message = this.redact(error.message)
        this.#update(id, entry.id, {
          status: 'failed',
          error: definitive
            ? `Lemex did not accept this message: ${message}`
            : `Delivery could not be confirmed; the message may have reached Lemex. Do not resend automatically. ${message}`,
        })
        if (error.code === -32600) return
      }
    }
  }
  async finish(id, reason = 'This run ended before the message was accepted.') {
    await this.deliveries.get(id)
    const job = this.events.get(id)
    for (const entry of job.followups || [])
      if (entry.status === 'pending')
        this.#update(id, entry.id, { status: 'failed', error: reason })
    return this.events.get(id)
  }
  recover() {
    if (!this.events.db) return
    for (const row of this.events.db
      .prepare('SELECT payload FROM jobs')
      .all()) {
      const job = JSON.parse(row.payload)
      if (!TERMINAL.has(job.status)) continue
      for (const entry of job.followups || [])
        if (entry.status === 'pending')
          this.#update(job.id, entry.id, {
            status: 'failed',
            error:
              'The run ended or the server restarted before delivery could be confirmed.',
          })
    }
  }
}
