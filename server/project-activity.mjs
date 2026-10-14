export class ProjectActivity {
  constructor({ events, jobs, agents, workspaces, runtime }) {
    Object.assign(this, { events, jobs, agents, workspaces, runtime })
    this.stopping = new Set()
  }

  #key(owner, projectId) {
    return JSON.stringify([owner, projectId])
  }

  isStopping(owner, projectId) {
    return this.stopping.has(this.#key(owner, projectId))
  }

  assertCanStart(owner, projectId) {
    if (this.isStopping(owner, projectId))
      throw Object.assign(
        new Error('This project is stopping its work. Wait for it to finish.'),
        { status: 409 },
      )
  }

  async withStopped(owner, projectId, action) {
    const project = this.workspaces.get(projectId, owner)
    this.assertCanStart(owner, projectId)
    const key = this.#key(owner, projectId)
    this.stopping.add(key)
    try {
      const results = await Promise.allSettled([
        this.jobs.stopProject(owner, projectId),
        this.agents.stopProject(owner, projectId),
        this.workspaces.stopPreparation(projectId, owner),
      ])
      // The runtime also owns editors and retains workers whose cleanup failed.
      // A stopped job receipt alone does not prove its container has exited.
      const roots = new Set([project.root])
      for (const job of this.events.projectMetadata(owner, projectId)) {
        if (job.snapshot?.root) roots.add(job.snapshot.root)
        if (job.verificationRoot) roots.add(job.verificationRoot)
      }
      for (const root of roots) await this.runtime.stopProject?.(root)
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
      if (
        this.events.activeMetadata(owner, projectId).length ||
        this.workspaces.jobs.has(projectId)
      )
        throw Object.assign(
          new Error('Some project work is still stopping. Try again shortly.'),
          { status: 409 },
        )
      return await action()
    } finally {
      this.stopping.delete(key)
    }
  }
}
