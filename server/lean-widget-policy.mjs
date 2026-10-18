export const LEAN_WIDGET_DISABLED_MESSAGE =
  'JavaScript widgets are disabled in this workspace. Lean goals and diagnostics remain available.'

function widgetMethod(message) {
  const method =
    message.method === '$/lean/rpc/call'
      ? message.params?.method
      : message.method
  return ['Lean.Widget.getWidgetSource', 'Lean.Widget.getWidgets'].includes(
    method,
  )
    ? method
    : null
}

const disabled = (id) => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32803, message: LEAN_WIDGET_DISABLED_MESSAGE },
})

// Lean's ordinary goals and hover RPCs return data. Widget source is executable
// project code, which the installed infoview otherwise imports into its
// same-origin iframe. Keep that source out of every browser, including old tabs.
export class LeanWidgetPolicy {
  constructor({ sendToClient, sendToLean }) {
    Object.assign(this, { sendToClient, sendToLean })
  }

  client(message) {
    const method = widgetMethod(message)
    if (!method) return true
    if ('id' in message)
      this.sendToClient(
        method === 'Lean.Widget.getWidgets'
          ? { jsonrpc: '2.0', id: message.id, result: { widgets: [] } }
          : disabled(message.id),
      )
    return false
  }

  server(message) {
    if (widgetMethod(message)) {
      if ('id' in message) this.sendToLean(disabled(message.id))
      return false
    }
    // A project controls its language server. Do not let unsolicited or forged
    // replies race a blocked source request by guessing a JSON-RPC id.
    if (
      !message.method &&
      message.result &&
      typeof message.result === 'object' &&
      Object.hasOwn(message.result, 'sourcetext')
    ) {
      if ('id' in message) this.sendToClient(disabled(message.id))
      return false
    }
    return true
  }
}
