function roleInput(input, { allowAdmin = false } = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'role') ||
    !(
      allowAdmin ? ['admin', 'editor', 'viewer'] : ['editor', 'viewer']
    ).includes(input.role)
  )
    throw Object.assign(
      new Error(
        allowAdmin
          ? 'Choose admin, editor or viewer access.'
          : 'Choose editor or viewer access.',
      ),
      {
        status: 400,
      },
    )
  return input.role
}

// Never return authentication, administrator, or provider details in search
// results. Results are bounded and require an explicit account-name query.
export function installProjectSharingRoutes(
  app,
  { workspaces, auth, onAccessChanged = () => {} },
) {
  const searches = new Map()
  const admitSearch = (actor, res) => {
    const now = Date.now()
    for (const [user, entry] of searches)
      if (now - entry.started >= 60_000) searches.delete(user)
    const entry = searches.get(actor) || { started: now, count: 0 }
    if (entry.count >= 30 || (!searches.has(actor) && searches.size >= 5000)) {
      res.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil((60_000 - (now - entry.started)) / 1000))),
      )
      throw Object.assign(
        new Error('Account search is busy. Wait a minute and try again.'),
        { status: 429 },
      )
    }
    entry.count++
    searches.set(actor, entry)
  }
  const authorize = (request) => {
    if (auth.identify(request)?.id !== request.user.id)
      throw Object.assign(new Error('Account access changed. Sign in again.'), {
        status: 401,
      })
  }
  const sharing = async (id, actor, request) => {
    await auth.refreshUsers()
    authorize(request)
    const result = workspaces.sharing(id, actor)
    return {
      ...result,
      members: result.members.map((member) => ({
        ...member,
        name:
          auth.users.find((user) => user.id === member.userId)?.name ||
          'Unavailable account',
      })),
    }
  }
  const afterMembershipChange = async (id, actor, request) => {
    try {
      return await sharing(id, actor, request)
    } catch (error) {
      // An admin can demote or remove themself after appointing another admin.
      // The change succeeded, but they can no longer inspect the member list.
      if ([403, 404].includes(error.status)) return { members: [], links: [] }
      throw error
    }
  }
  const stopChangedAccess = (id, actor, previousRole) => {
    // Membership is already durable. Revoke transports immediately, but do not
    // make a successful permission response wait for worker teardown.
    try {
      void Promise.resolve(onAccessChanged(id, actor, { previousRole })).catch(
        () => {
          console.error('[LeanFlow sharing] Revoked work is still cleaning up.')
        },
      )
    } catch {
      console.error('[LeanFlow sharing] Revoked work is still cleaning up.')
    }
  }
  app.get('/api/projects/:id/sharing', async (req, res) => {
    res.json(await sharing(req.params.id, req.user.id, req))
  })
  app.get('/api/accounts/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (query.length < 2 || query.length > 80)
      throw Object.assign(new Error('Search using 2–80 characters.'), {
        status: 400,
      })
    admitSearch(req.user.id, res)
    await auth.refreshUsers()
    authorize(req)
    res.json(
      auth.users
        .filter(
          (user) =>
            user.id !== req.user.id &&
            user.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .slice(0, 20)
        .map(({ id, name }) => ({ id, name })),
    )
  })
  app.put('/api/projects/:id/sharing/members/:userId', async (req, res) => {
    workspaces.requireAdmin(req.params.id, req.user.id)
    const role = roleInput(req.body, { allowAdmin: true })
    await auth.refreshUsers()
    if (!auth.users.some((user) => user.id === req.params.userId))
      throw Object.assign(new Error('Account not found. Search again.'), {
        status: 404,
      })
    let previousRole
    await workspaces.setMember(
      req.params.id,
      req.user.id,
      req.params.userId,
      role,
      {
        assertAuthorized: () => authorize(req),
        onPreviousRole: (value) => {
          previousRole = value
        },
      },
    )
    stopChangedAccess(req.params.id, req.params.userId, previousRole)
    res.json(await afterMembershipChange(req.params.id, req.user.id, req))
  })
  app.delete('/api/projects/:id/sharing/members/:userId', async (req, res) => {
    workspaces.requireAdmin(req.params.id, req.user.id)
    let previousRole
    await workspaces.removeMember(
      req.params.id,
      req.user.id,
      req.params.userId,
      {
        assertAuthorized: () => authorize(req),
        onPreviousRole: (value) => {
          previousRole = value
        },
      },
    )
    stopChangedAccess(req.params.id, req.params.userId, previousRole)
    res.json(await afterMembershipChange(req.params.id, req.user.id, req))
  })
  app.post('/api/projects/:id/sharing/links', async (req, res) => {
    const link = await workspaces.createShareLink(
      req.params.id,
      req.user.id,
      roleInput(req.body),
      { assertAuthorized: () => authorize(req) },
    )
    res.status(201).json(link)
  })
  app.delete('/api/projects/:id/sharing/links/:linkId', async (req, res) => {
    await workspaces.revokeShareLink(
      req.params.id,
      req.user.id,
      req.params.linkId,
      { assertAuthorized: () => authorize(req) },
    )
    res.json(await sharing(req.params.id, req.user.id, req))
  })
  app.post('/api/project-invitations/join', async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => key !== 'token') ||
      typeof req.body.token !== 'string'
    )
      throw Object.assign(new Error('Open a valid project sharing link.'), {
        status: 400,
      })
    const { root: _root, ...project } = await workspaces.joinShareLink(
      req.user.id,
      req.body.token,
      { assertAuthorized: () => authorize(req) },
    )
    res.json(project)
  })
}
