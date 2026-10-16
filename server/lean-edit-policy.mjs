import {
  LEAN_EDIT_DISABLED_MESSAGE,
  isDisabledLeanEditMethod,
} from '../shared/lean-edit-policy.mjs'

// Enforce this at the relay as well as the UI. Existing tabs and direct LSP
// clients must not be able to bypass a disabled editor operation.
export class LeanEditPolicy {
  constructor({ sendToClient, sendToLean }) {
    Object.assign(this, { sendToClient, sendToLean })
    this.initializing = new Set()
  }

  client(message) {
    if (isDisabledLeanEditMethod(message.method)) {
      if ('id' in message)
        this.sendToClient({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32803, message: LEAN_EDIT_DISABLED_MESSAGE },
        })
      return false
    }
    if (message.method === 'initialize' && 'id' in message) {
      this.initializing.add(message.id)
      if (message.params?.capabilities?.workspace)
        message.params.capabilities.workspace.applyEdit = false
    }
    return true
  }

  server(message) {
    if (message.method === 'workspace/applyEdit') {
      if ('id' in message)
        this.sendToLean({
          jsonrpc: '2.0',
          id: message.id,
          result: { applied: false, failureReason: LEAN_EDIT_DISABLED_MESSAGE },
        })
      return false
    }
    const registrations =
      message.method === 'client/registerCapability'
        ? 'registrations'
        : message.method === 'client/unregisterCapability'
          ? 'unregisterations'
          : null
    if (registrations && Array.isArray(message.params?.[registrations])) {
      message.params[registrations] = message.params[registrations].filter(
        (entry) => !isDisabledLeanEditMethod(entry.method),
      )
      if (!message.params[registrations].length) {
        if ('id' in message)
          this.sendToLean({ jsonrpc: '2.0', id: message.id, result: null })
        return false
      }
    }
    if (!message.method && this.initializing.delete(message.id)) {
      const capabilities = message.result?.capabilities
      if (capabilities) {
        capabilities.renameProvider = false
        capabilities.codeActionProvider = false
        delete capabilities.executeCommandProvider
        if (capabilities.workspace) delete capabilities.workspace.fileOperations
      }
    }
    return true
  }

  dispose() {
    this.initializing.clear()
  }
}
