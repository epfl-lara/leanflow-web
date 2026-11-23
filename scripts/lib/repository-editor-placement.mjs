import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// Inspect only containers labelled as LeanFlow workers. Match the real project
// mount and lake serve command; setup/build jobs do not count as live editors.
export async function repositoryPlacements(
  dataDir,
  participants,
  requireCluster,
) {
  const root = await fs.realpath(dataDir)
  const projectIds = [...new Set(participants.map((p) => p.project.id))]
  const mounts = new Map(
    projectIds.map((id) => [path.join(root, 'projects', id), id]),
  )
  const result = { remote: [], local: [], pending: 0 }
  const { stdout } = await execute('docker', [
    'ps',
    '--filter',
    'label=lemex-web.owner',
    '--format',
    '{{.ID}}',
  ])
  const containers = stdout.trim().split(/\s+/).filter(Boolean)
  if (containers.length) {
    const inspected = await execute('docker', [
      'inspect',
      '--format',
      '{{json .Config.Cmd}}\t{{json .Mounts}}',
      ...containers,
    ]).catch((error) => {
      // Closing an editor can remove its --rm container after "ps".
      // Docker still prints records for the other containers in this batch.
      const messages = String(error.stderr || '')
        .trim()
        .split('\n')
      if (
        error.code !== 1 ||
        !messages.every((message) => {
          const missing =
            /^(?:error(?: response from daemon)?:\s*)?no such (?:object|container):\s*([0-9a-f]+)$/i.exec(
              message,
            )
          return missing && containers.includes(missing[1])
        })
      )
        throw error
      return { stdout: error.stdout }
    })
    for (const row of inspected.stdout.trimEnd().split('\n').filter(Boolean)) {
      const [command, volumes] = row.split('\t').map((s) => JSON.parse(s))
      if (command?.slice(-3).join(' ') !== 'lake serve --') continue
      const project = mounts.get(
        volumes.find((v) => v.Destination === '/workspace')?.Source,
      )
      if (project) result.local.push(project)
    }
  }
  const filename = path.join(root, 'cluster/cluster-controller.sqlite')
  if (!requireCluster && !(await fs.stat(filename).catch(() => null)))
    return result
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const query =
      db.prepare(`SELECT node, state, json_extract(payload,'$.actor') AS actor,
         json_extract(payload,'$.projectId') AS project
      FROM cluster_attempts
      WHERE state NOT IN ('completed','cancelled','failed','interrupted') AND json_extract(payload,'$.operation')='lean.session'
        AND json_extract(payload,'$.editorKind')='repository'
        AND json_extract(payload,'$.projectId') IN (${projectIds.map(() => '?').join(',')})`)
    const active = query.all(...projectIds)
    result.remote = active.filter((r) => r.state === 'running')
    result.pending = active.length - result.remote.length
    for (const row of result.remote) {
      assert(
        participants.some(
          (p) => p.project.id === row.project && p.account.id === row.actor,
        ),
        'Foreign receipt for a disposable fixture project',
      )
    }
    assert.equal(
      new Set(result.remote.map((r) => r.actor)).size,
      result.remote.length,
    )
  } finally {
    db.close()
  }
  return result
}

export function summarizePlacements(result, participants, requiredNodes) {
  assert.equal(result.pending, 0, 'Every assigned editor must finish starting')
  const nodes = {}
  for (const r of result.remote) nodes[r.node] = (nodes[r.node] || 0) + 1
  for (const host of requiredNodes)
    assert(
      nodes[host] > 0,
      'No running repository session witnessed on ' + host,
    )
  for (const id of new Set(participants.map((p) => p.project.id))) {
    const observed =
      result.local.filter((p) => p === id).length +
      result.remote.filter((p) => p.project === id).length
    assert.equal(
      observed,
      participants.filter((p) => p.project.id === id).length,
      'Running Lean workers must match the number of authenticated editors for this project',
    )
  }
  return { local: result.local.length, remote: nodes }
}
