function invalid(message, status = 400) {
  throw Object.assign(new Error(message), { status })
}

export class TrashManager {
  constructor({ workspaces, chats, events, assertIdle, redact = String }) {
    Object.assign(this, { workspaces, chats, events, assertIdle, redact })
  }

  get(owner, id) {
    try {
      return this.workspaces.getTrash(id, owner)
    } catch (error) {
      if (error.status !== 404) throw error
      return this.chats.getTrash(id, owner)
    }
  }

  async deleteForever(owner, id) {
    const entry = this.get(owner, id)
    if (entry.kind === 'chat') return this.chats.deleteForever(owner, id)
    const assertIdle = () => this.assertIdle(entry.projectId, owner)
    assertIdle()
    const result = await this.workspaces.deleteForever(id, owner, {
      assertIdle,
      candidateRunIds:
        entry.kind === 'project'
          ? this.events
              .projectMetadata(owner, entry.projectId)
              .map((job) => job.id)
          : [],
    })
    if (entry.kind === 'project')
      this.chats.deleteProject(owner, entry.projectId)
    return result
  }

  async deleteAll(owner, input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'trashIds') ||
      !Array.isArray(input.trashIds) ||
      input.trashIds.some((id) => typeof id !== 'string') ||
      new Set(input.trashIds).size !== input.trashIds.length
    )
      invalid('Choose the Trash items to delete and confirm Delete Forever.')

    // Resolve every owner-scoped receipt before deleting anything. The supplied
    // IDs are the confirmation's snapshot, so newly trashed items stay intact.
    const items = input.trashIds.map((id) => this.get(owner, id))
    if (items.some((item) => !item.recoverable && !item.deleting))
      invalid(
        'Trash changed. Close this confirmation and open Trash again.',
        409,
      )
    items.sort(
      (a, b) => Number(b.kind === 'project') - Number(a.kind === 'project'),
    )
    const deletedTrashIds = new Set()
    const failures = []
    for (const item of items) {
      if (deletedTrashIds.has(item.trashId)) continue
      try {
        await this.deleteForever(owner, item.trashId)
        deletedTrashIds.add(item.trashId)
        if (item.kind === 'project')
          for (const child of items)
            if (child.projectId === item.projectId)
              deletedTrashIds.add(child.trashId)
      } catch (error) {
        failures.push({
          trashId: item.trashId,
          name: item.name || item.path || item.projectName || 'Deleted item',
          error: this.redact(
            error.status
              ? error.message
              : 'This item could not be deleted. Retry, or contact the server administrator.',
          ),
        })
      }
    }
    return { deletedTrashIds: [...deletedTrashIds], failures }
  }
}
