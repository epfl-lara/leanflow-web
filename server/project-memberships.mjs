import { createHash, randomBytes, randomUUID } from 'node:crypto'

const digest = (token) => createHash('sha256').update(token).digest('hex')
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status, statusCode: status })
}

function role(value) {
  if (!['admin', 'editor', 'viewer'].includes(value))
    fail('Choose admin, editor or viewer access.')
  return value
}

function identity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
    fail('Choose a valid account.')
  return value
}

// Membership and link changes run inside WorkspaceStore's project write queue.
// Link secrets are returned once; only their hashes are persisted.
export class ProjectMemberships {
  constructor(db) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_members (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
        PRIMARY KEY(project,user)
      );
      CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user);
      CREATE TABLE IF NOT EXISTS project_share_links (
        id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
        created_at TEXT NOT NULL
      );
    `)
    db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_migrations (id TEXT PRIMARY KEY)',
    )
    if (
      !db
        .prepare('SELECT 1 FROM workspace_migrations WHERE id=?')
        .get('project-admin-roles-v1')
    ) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const schema = db
          .prepare("SELECT sql FROM sqlite_master WHERE name='project_members'")
          .get().sql
        if (!schema.includes("'admin'")) {
          db.exec(`
            ALTER TABLE project_members RENAME TO project_members_previous;
            CREATE TABLE project_members (project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              user TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), PRIMARY KEY(project,user));
            INSERT INTO project_members SELECT * FROM project_members_previous;
            DROP TABLE project_members_previous;
            CREATE INDEX project_members_user ON project_members(user);
          `)
        }
        db.exec(
          "INSERT OR IGNORE INTO project_members(project,user,role) SELECT id,owner,'admin' FROM projects",
        )
        db.prepare('INSERT INTO workspace_migrations(id) VALUES(?)').run(
          'project-admin-roles-v1',
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS project_initial_admin AFTER INSERT ON projects BEGIN
      INSERT INTO project_members(project,user,role) VALUES(NEW.id,NEW.owner,'admin');
    END`)
  }

  role(projectId, userId) {
    return this.db
      .prepare('SELECT role FROM project_members WHERE project=? AND user=?')
      .get(projectId, userId)?.role
  }

  list(projectId) {
    return {
      members: this.db
        .prepare(
          'SELECT user AS userId,role FROM project_members WHERE project=? ORDER BY user',
        )
        .all(projectId),
      links: this.db
        .prepare(
          'SELECT id,role,created_at AS createdAt FROM project_share_links WHERE project=? ORDER BY created_at',
        )
        .all(projectId),
    }
  }

  set(project, userId, accessRole) {
    identity(userId)
    role(accessRole)
    if (accessRole !== 'admin') this.assertAnotherAdmin(project.id, userId)
    this.db
      .prepare(
        'INSERT INTO project_members(project,user,role) VALUES(?,?,?) ON CONFLICT(project,user) DO UPDATE SET role=excluded.role',
      )
      .run(project.id, userId, accessRole)
  }

  remove(project, userId) {
    identity(userId)
    this.assertAnotherAdmin(project.id, userId)
    this.db
      .prepare('DELETE FROM project_members WHERE project=? AND user=?')
      .run(project.id, userId)
  }

  assertAnotherAdmin(projectId, userId) {
    const otherActiveAdmin = this.db
      .prepare(
        "SELECT user FROM project_members WHERE project=? AND role='admin' AND user<>?",
      )
      .all(projectId, userId)
      .some((member) => this.isActiveUser?.(member.user) !== false)
    if (this.role(projectId, userId) === 'admin' && !otherActiveAdmin)
      fail(
        'Keep at least one project admin. Grant another account admin access first.',
        409,
      )
  }

  createLink(projectId, accessRole) {
    if (!['editor', 'viewer'].includes(accessRole))
      fail(
        'Invitation links support editor or viewer access. Grant admin access to a named account.',
      )
    if (
      this.db
        .prepare(
          'SELECT COUNT(*) AS count FROM project_share_links WHERE project=?',
        )
        .get(projectId).count >= 20
    )
      fail(
        'This project already has 20 invitation links. Revoke an unused link first.',
        409,
      )
    const token = randomBytes(32).toString('base64url')
    const link = {
      id: randomUUID(),
      role: accessRole,
      createdAt: new Date().toISOString(),
    }
    this.db
      .prepare(
        'INSERT INTO project_share_links(id,project,token_hash,role,created_at) VALUES(?,?,?,?,?)',
      )
      .run(link.id, projectId, digest(token), accessRole, link.createdAt)
    return { ...link, token }
  }

  revokeLink(projectId, linkId) {
    identity(linkId)
    this.db
      .prepare('DELETE FROM project_share_links WHERE project=? AND id=?')
      .run(projectId, linkId)
  }

  invitation(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail('This invitation link is invalid or has been revoked.', 404)
    const link = this.db
      .prepare(
        'SELECT project,role FROM project_share_links WHERE token_hash=?',
      )
      .get(digest(token))
    if (!link) fail('This invitation link is invalid or has been revoked.', 404)
    return link
  }
}
