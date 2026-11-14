# Operate distributed checks and storage

Use [execution worker setup](DistributedExecution.md) to enroll machines and
[user account installation](UserExecutionWorkers.md) for administrator-prepared
shared PCs. This guide covers operation after enrollment.

## Know what each machine stores

| Data                                                                           | Location                                      | Recovery policy                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------- |
| Accounts, SQLite databases, saved projects, retained runs and source history   | Coordinator                                   | Authoritative data; back up independently                        |
| Published toolchains and prepared public dependency environments               | Coordinator runtime                           | Protected originals used by local work and indexed for transfers |
| Transfer manifests, source/result objects, partial uploads and source index    | Coordinator cluster directory                 | Bounded cache and private metadata; preserve indexed originals   |
| Container images, installed toolchains and disposable dependency/object caches | Each execution worker's local volume          | Rebuildable copies; not backups of saved projects                |
| Writable check output and scratch                                              | Each job's isolated memory-backed filesystems | Removed after confirmed cleanup; charged to the job's RAM        |

Worker disks are already used for execution assets and caches. They are not
automatically joined into the coordinator filesystem. Do not move project
databases to a worker or mount a shared writable project tree to increase space.
The website, editors, agents, terminals, setup and canonical writes still depend
on the coordinator. Worker capacity does not make it highly available.

## Add capacity by workload

Admit jobs against each host's measured CPU, RAM, scratch and slot budgets.
Count ready, compatible and certified workers only. An unavailable primary or
inactive reserve contributes no capacity. A large check must fit one host;
capacity on several PCs cannot be combined for one process.

For example, an eight-CPU, 24-GiB job pool with four slots can admit four ordinary
checks reserving two CPUs and 6 GiB each. A native check reserves three slots,
six CPUs and 18 GiB, leaving room for one ordinary check. Native checks also have
a one-per-host limit. These are job counts, not simultaneous-user claims.
Editors, model calls, agent runs and setup have separate coordinator and
provider limits.

Use [the worker expansion plan](WorkerExpansion.md) to prepare more primary
workers, including a smaller regular allocation on a shared host. It also
separates check-worker enrollment from the application work needed for more
simultaneous live Lean editors.

The [ten-user compilation test](releases/2026-11-13-ten-user-compilation.md)
records 70 successful checks, real browser editing and saving, observed queue
behavior, and commands for repeating the test with disposable accounts.

Increase a pool only after measuring representative cold and warm projects,
heavy native checks, cancellation, queue fairness and filesystem headroom.
Keep daemon and host headroom in addition to container limits. Docker access,
the outer slice, AppArmor, disk boundaries and approved shared-machine budgets
remain administrator-controlled. Reserve activation through `allowReserve` is
explicit; it is not automatic failover.

## Keep execution caches bounded

The coordinator indexes protected public runtime files instead of retaining a
second payload copy. The private source index is bounded by `maxStoreFiles`.
The coordinator default is 250,000; measure unique assets and raise this setting
before an environment exceeds it. The November rollout uses 500,000, as recorded
in its [deployment report](releases/2026-11-13-distributed-storage.md).
Physical objects remain bounded by `maxStoreBytes` and `maxStoreFiles`; writes
preserve `reserveBytes`. Workers retain their own physical caches. These limits
do not reserve disk against other users or replace a filesystem quota.

Index rows record hashes and original file identities. Reads reject changed,
missing, hardlinked or redirected originals, and transfers verify SHA-256.
Each hash currently has one backing reference; a later capture can replace it
with another identical managed file. Preserve indexed environments even if
identical bytes exist elsewhere. For changed originals, restart the coordinator
and recapture the affected environment before retrying.

| Maintenance command | Effect                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trim`              | Removes coordinator payload duplicates with valid sources; preserves originals, partial uploads and unindexed objects; never connects to workers                                                            |
| `gc --node NODE`    | Clears the selected worker's disposable dependency/object cache, preserving its pinned toolchains; always clears coordinator objects, partial uploads and source references, and compacts resolved receipts |

Both require cluster mode `off`, drained work and exclusive controller-state
ownership. Neither deletes saved projects. Full GC can cause large cold
transfers; use `trim` when duplicate coordinator payloads need reclaiming.
Automatic retention, background object eviction and durable artifact replication
are not implemented.

## Perform idle maintenance

1. Wait for proof jobs, setup, editor analysis and terminal subprocesses to
   finish. Check queued work, remote attempts, held grants and cleanup failures.
   Do not restart an active proof to deploy or reclaim disk.
2. Record the active release, protected configuration, image, worker bundle,
   lineage and controller generation. Preserve the current release and back up
   authoritative databases and files consistently. Do not fork or restore the
   enrolled controller database as a deployment rollback.
3. Stop website admission and drain its controller before maintenance. Set the
   protected cluster configuration to `off` and confirm snapshot helpers have
   exited. Preserve the approved worker-service lifetime if user services
   depend on an open SSH login.
4. With the compatible coordinator checkout, recapture managed environments
   using the [documented `prepare` commands](DistributedExecution.md#configure-and-roll-out).
   Workers reuse verified objects.
   Check source-index and physical-cache budgets separately. Verify indexed
   originals before removing older payload copies.
5. Run the command with the real configuration, data directory and pinned image:

   ```sh
   node server/cluster/control.mjs trim --config /private/controller.json --data /coordinator/data --image sha256:IMAGE_ID
   node server/cluster/control.mjs status --config /private/controller.json --data /coordinator/data --image sha256:IMAGE_ID
   ```

6. Restore the intended mode, start the reviewed website release and complete
   acceptance below. Keep command output and filesystem measurements privately.

The CLI advances the existing controller generation under its exclusive lock.
Unlike `trim`, `status` also connects to every enabled worker. Expect a new
generation handshake and reconciliation; it is not a passive database query.
Keep the enrolled lineage and monotonic database history. Never run a second
controller against a copied database. `status` is also a maintenance command;
do not start it beside the live website controller.

`trim` syncs deletions before releasing quota. Interrupted charges can remain
conservative; retry under the same maintenance conditions. Invalid backings are
skipped instead of deleting the remaining payload. Investigate unexpected skips
before counting their space as reclaimed.

## Verify a deployment

- Check website health, authenticated session, native runtime/model availability
  and the JavaScript/CSS assets actually served over HTTPS.
- Require certification for the current worker-process epoch, image and bundle.
  An SSH connection or running service alone is insufficient.
- Run valid and invalid checks through the website API without model calls.
  Require expected exit codes and a `remote-completed` audit entry for each job,
  plus its matching attempt receipt naming the worker. Local fallback is not
  evidence of remote serving.
- After trimming, hash samples whose coordinator payload copies are absent.
  Exercise a real cache-miss upload to the installed worker and verify returned
  bytes. A small isolated transfer fixture avoids clearing production caches;
  label it separately from proof evidence.
- Confirm cleanup and no held work, compare actual free bytes and keep reports.
  Remove disposable validation trees and duplicate staging indexes.

The full source-hash audit, backed-read samples, website API audit and cache-miss
probe require reviewed administrator scripts on the coordinator; they are not
standalone shipped CLI commands. `trim` itself checks original file identities
before deletion; it does not rehash all backing content. The deployment reports
distinguish the independent hash audit from the trim operation.

Keep the production SSH key restricted to the control/bulk protocol. Do not use
Docker privileges or the bridge to obtain a shell. Host upgrades use an approved
installation or temporary access; revoke temporary keys afterwards. Do not run
an AI coding agent on worker hosts.

## Roll back safely

With work idle, restore the previous reviewed website release and configuration.
Preserve lineage, generations, receipts and source index. A previous release
that supports references can continue using them. For a release that cannot
resolve references after `trim`, set cluster mode `off`: local execution still
uses untouched canonical runtime assets. Re-enable distributed serving only
with a compatible coordinator and fresh acceptance.

Keep project/database backups separate from execution caches. Restoring old
authoritative controller state needs a planned new lineage and explicit node
re-enrollment, as described in [execution setup](DistributedExecution.md).

## Expand durable storage separately

Enroll additional primary workers and measure throughput within approved host
budgets. Keep reserves optional. Before moving retained artifacts, implement
independent verified replicas, atomic publication metadata, read routing,
unavailable-node handling and tested backup restoration. Do not remove the
authoritative coordinator copy merely because a worker has a disposable cache.
