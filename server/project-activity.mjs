export class ProjectActivity {
  constructor({ events, jobs, agents, workspaces, runtime, texBuilds }) {
    Object.assign(this, {
      events,
      jobs,
      agents,
      workspaces,
      runtime,
      texBuilds,
    })
    this.stopping = new Set()
  }

  isStopping(_owner, projectId) {
    return this.stopping.has(projectId)
  }

  assertCanStart(owner, projectId) {
    if (this.isStopping(owner, projectId))
      throw Object.assign(
        new Error('This project is stopping its work. Wait for it to finish.'),
        { status: 409 },
      )
  }

  async withStopped(
    owner,
    projectId,
    action,
    { preserveEditors = false } = {},
  ) {
    const project = this.workspaces.get(projectId, owner)
    this.assertCanStart(owner, projectId)
    const setupActor = this.workspaces.preparationActors?.get(projectId)
    if (
      this.workspaces.jobs.has(projectId) &&
      setupActor &&
      setupActor !== owner
    )
      throw Object.assign(
        new Error(
          'Another collaborator is preparing this project. Wait for setup to finish before moving files.',
        ),
        { status: 409 },
      )
    const otherWork = this.events.db
      .prepare(
        "SELECT 1 FROM jobs WHERE owner<>? AND json_extract(payload,'$.projectId')=? AND (json_extract(payload,'$.status') IN ('queued','starting','running','stopping','verifying','preparing') OR json_extract(payload,'$.cleanupFailed')=1) LIMIT 1",
      )
      .get(owner, projectId)
    const finishingOtherWork = [this.jobs, this.agents, this.texBuilds].some(
      (manager) =>
        [...(manager?.active?.keys() || [])].some((id) => {
          const job = this.events.getMetadata(id)
          return job.projectId === projectId && job.owner !== owner
        }),
    )
    if (otherWork || finishingOtherWork)
      throw Object.assign(
        new Error(
          'Another collaborator has active work in this project. Wait for it to finish before moving project data.',
        ),
        { status: 409 },
      )
    // Block starts for every member before awaiting worker teardown. No store
    // lock is held: a stopping mirror may still need to finish its short commit.
    this.stopping.add(projectId)
    try {
      const results = await Promise.allSettled([
        this.jobs.stopProject(owner, projectId),
        this.texBuilds?.stopProject(owner, projectId),
        this.agents.stopProject(owner, projectId),
        this.workspaces.stopPreparation(projectId, owner),
      ])
      // The runtime also owns editors and retains workers whose cleanup failed.
      // A stopped job receipt alone does not prove its container has exited.
      const roots = new Set([
        ...(preserveEditors ? [] : [project.root]),
        ...(this.texBuilds?.workerRoots(owner, projectId) || []),
      ])
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
      this.stopping.delete(projectId)
    }
  }
}
