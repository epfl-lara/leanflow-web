# Run live Lean editors on execution workers

Deploy a reviewed worker bundle, preload its pinned environments, pass the
editor conformance test, and then enable remote placement. Canonical project
files, authentication, collaboration and saves stay on the coordinator. Each
remote editor receives a disposable source copy and an isolated `lake serve`
container. This does not add general project storage on the PCs.

Editors reuse the same controller, resource grants, worker daemon and cleanup
paths as distributed checks. SSH, Docker/cgroups, systemd and Lean's LSP provide
the underlying services. Scheduling, leases and artifact transfer remain custom
LeanFlow code; this is not a third-party cluster orchestrator or a highly
available coordinator.

Remote placement is **off by default** for new installations. Enable a worker's
editor slots after its reviewed upgrade and acceptance. The
[17 November four-machine rollout](releases/2026-11-17-primary-workers.md)
records the earlier 32-slot configuration and concurrency tests. The preceding
[PC06 rollout](releases/2026-11-16-remote-editors.md) records the initial integration.

The four machines have 27 configured editor slots in total. The VM
and PC06 have nine each, PC2 has five, and PC05 has four. PC05 uses 6.75 GiB per
editor and reserves 18 GiB for proof checks within its 45 GiB memory budget.
On 20 November, an isolated cold Mathlib editor check on PC05 timed out after
110 seconds at 3 GiB and completed in 32 seconds at 6.75 GiB.

See [cache reuse](Caching.md) for shared Lean artifacts, incremental editor
sessions, coordinator improvements and measured limits.

See [25 participants in a shared project](releases/2026-11-18-shared-competition.md) for two-file collaboration and queued file checks. The [individual-playground rehearsal](releases/2026-11-17-competition-readiness.md) covers participants working in separate playgrounds.

## Eligible editors

The managed single-file editor uses a workspace with `Main.lean`,
an installed official Lean toolchain, and verified public dependencies. Mathlib
is supported when its exact public environment has been preloaded. Source
snapshots containing private files, symbolic links, additional Lean modules or
more than 16 MiB stay local under this single-file policy.

To distribute interactive editors for multi-file repositories, set
`editors.repositories` to `true` alongside `"placement": "prefer"` after
qualifying the workers. Each worker must report `lean.repositorySession`.
Qualification opens a proof importing a project-local module, changes that
module, reopens the proof on the same live connection and checks its new value.
Both editor types share the worker's CPU, RAM and slot budget.

Project setup preloads the pinned Lean toolchain and transferable, verified
dependencies in the background. Opening an older project can start the same
preparation. A repository needs a complete Lake configuration and package lock,
a source snapshot the worker can reproduce, and installed copies of its exact
toolchain and dependencies. Workspaces that rely on private local packages,
or exceed the worker's limits, use the coordinator. Each admitted session
builds its project imports in its own bounded workspace. Ordinary saves to
existing Lean modules are mirrored to active sessions. Refresh imports to
re-elaborate an open proof against a changed dependency. Adding, deleting or
renaming files reconnects the editor to a fresh snapshot with its draft intact.
After two such reconnects in a minute, use **Restart Lean** when the changes
finish. A change to the project configuration can require setup again.

Participants can submit **Check File** from a multi-file project while waiting
for an editor. Shared check workers can compile a saved file when the project
matches the warmed public configuration and its imports use the prepared
Mathlib or standard libraries. A project-local import, custom Lake configuration,
or missing library module uses the coordinator's pinned Lake compiler, which
builds the dependencies of the selected file. Check Project can also use the
shared check workers for projects with the exact warmed public configuration.

A worker must advertise the certified `lean.session` capability and already
hold the exact toolchain, dependency and qualified public configuration manifests.
Installing dependency bytes alone does not qualify an editor environment. A
browser connection never
starts a large dependency upload. If placement or capture is unavailable before
launch, the editor uses the existing local path. A started remote session closes
on failure; it does not replay a possibly stale session on another machine.

The coordinator captures the protected public Mathlib assets in a bounded,
service-owned background task after startup. While that task runs, editor
admission stays local. Opening or closing a browser does not start or cancel that
capture. This keeps a cold asset scan outside the editor's initialization path.

The coordinator mirrors canonical `Main.lean` saves with ordered revisions and
content hashes. Subsequent client messages wait for pending save acknowledgments.
Unsaved text travels through ordinary LSP messages and never becomes a worker
write to the canonical project. Adding another module, changing configuration,
renaming/deleting files, or removing access closes the disposable session.
Reopening chooses the appropriate current environment or local editor.

Public template exports use protected file references in the coordinator's
existing object store, so they do not add another full dependency payload on the
VM. Their directory, certificate and indexed files must be service-owned and
not writable by another account. Legacy group-writable templates can still serve
local editors, but need an idle permission/provenance review before export.
Editor exports refuse unprotected files and directories instead of copying their
payloads. Sanitized Git metadata is generated separately in the bounded store.

## Share the existing worker budget

Configure editor admission inside the worker's agreed pool. RAM uses the full
container cap for every admission. On a shared machine whose outer slice is
larger than the agreed pool, the sum of container CPU caps must also fit the pool.

For an existing **24 GiB / 8 CPU** worker pool, the policy accepted in the rollout
leaves an ordinary check worker available:

```json
{
  "workerMemory": "6g",
  "workerCpus": 2,
  "memoryBudget": "24g",
  "maxCpus": 8,
  "maxConcurrent": 7,
  "editors": {
    "maxConcurrent": 6,
    "memory": "3g",
    "cpus": 1,
    "cpuReservation": 1,
    "reservedBatchMemory": "6g",
    "reservedBatchCpus": 2
  }
}
```

Merge these fields into the protected node configuration; preserve its identity,
paths, image, lineage and outer slice settings. This policy does not raise the
24 GiB / 8 CPU pool. Six editors reserve 18 GiB / 6 CPU, leaving 6 GiB / 2 CPU
for an ordinary check. Each editor has a one-CPU cap. A policy that admits less
CPU than the editors can consume is accepted only when the pool is also bounded
by an equally sized, verified outer CPU slice; otherwise the caps must all fit.
Measure responsiveness under the selected CPU cap before enabling the pool.

Native checks need 18 GiB / 6 CPU. When persistent editors cannot leave that
allocation on any remote node, checks use the coordinator instead of waiting
behind editors. The coordinator must retain its own native-check reserve. To
guarantee a native check on every PC instead, reduce that PC's editor allocation
until its full native grant fits alongside all admitted editors.

Per-user and per-project editor limits apply across local and remote processes.
`STUDIO_MAX_EDITORS` supplies the local admission ceiling. Certified, enabled
workers add their editor slots. Set `STUDIO_MAX_TOTAL_EDITORS=22` to admit up to
22 editors across those machines and queue additional connections. Leave it
unset to use the existing local and remote limits. The number that can start
also depends on worker availability, project eligibility, CPU and memory.

## Waiting for an editor

The [17 November rollout report](releases/2026-11-17-editor-queue.md) records
the original limits and acceptance tests.

Open the project normally. If its editor cannot start yet, LeanFlow shows its
position in a waiting list and connects automatically when capacity is available.
The tab can still edit and save canonical source while waiting. Diagnostics,
goals and completion become available after Lean starts. Closing the project or
tab cancels its wait. Waiting tabs do not allocate Lean workers, containers or
remote project snapshots.

Active editors keep their workers. A slot becomes reusable after worker cleanup
is confirmed, rather than as soon as the browser disconnects. Admission checks
the current account, project, worker resources and remote placement again before
starting. An unsupported remote project waits for local capacity; repository
editors still use their existing larger allocation.

The default waiting room holds 128 connections, at most three per account, for
up to one hour. These limits are separate from active per-account and
per-project limits. The next eligible request starts in arrival order. Extra
tabs from an account at its limit keep their place while other participants
use available slots in the same shared project. Each account's tabs start in
order. A project waiting for worker capacity leaves other projects free to
start. If a worker fills during startup, the tab keeps its original place and
deadline during a short retry delay. Its place remains reserved until startup
succeeds, even if the waiting room fills. The coordinator starts one resource
reservation at a time. Running editors execute in parallel. Failed starts
retain only their own slot and waiting place while cleanup is unconfirmed;
healthy workers can continue starting other tabs. An unavailable worker's held
grants are counted separately from its lost capacity, avoiding a second capacity
penalty. Account and project limits remain held until cleanup is confirmed.
Queue positions
therefore show arrival order, not a promised
start time. A dropped worker reduces available capacity without evicting other
running sessions. Resource changes are checked every 500 ms while tabs wait.

Configure `STUDIO_MAX_EDITOR_QUEUE`, `STUDIO_MAX_EDITOR_QUEUE_PER_USER` and
`STUDIO_EDITOR_QUEUE_WAIT_MS` as shown in [.env.example](../.env.example).
A wait time of `0` keeps a connected, authorized tab on the list until capacity opens or the participant leaves. Account and service queue limits still apply.
Only a full waiting room, its account limit, or an expired wait rejects overflow;
closing unused tabs makes room. Waiting state is in memory: a service restart
closes those sockets, and reopening the project joins the new waiting list.
The authenticated `/api/session` capacity snapshot includes
`editorAdmission.active`, `editorAdmission.queued` and
`editorAdmission.maxQueued`, without exposing account or project identities.

The browser receives `$/leanflow/editorQueue` notifications before its pending
LSP `initialize` completes. A version-checked transform of the existing editor
wrapper intercepts only that notification and preserves its normal message
strategy. Its workspace cancellation signal also closes a pending socket before
initialization, so changing projects promptly leaves the waiting list. Pending
input is limited to 256 KiB per waiting connection; active
traffic retains its existing transport bound. Waiting does not trigger the
30-minute editor sleep timer. Active, unattended editors still sleep normally
to return capacity.

Run these checks for queue ordering, cleanup and the actual Monaco waiting
display. The browser check also saves before admission and promotes on one socket.

```sh
node --test server/tests/editor-admission.test.mjs server/tests/queued-editor.test.mjs
npm run build
node scripts/ci/check-browser.mjs editor-queue
```

## Upgrade and enable

1. Package the committed source with
   `node scripts/package-cluster-worker.mjs --output /private/release-output`.
   Preserve its source revision, archive checksum and bundle digest. The image
   remains pinned separately. The added RPC methods retain framing protocol 2;
   the exact bundle pin and fresh capability certification gate their use.
2. Use an administrator-approved maintenance route or have the administrator
   install the reviewed bundle. Install into a new release directory in the
   dedicated account's home. Never use Docker rights or the production bridge
   to obtain a shell. No AI agent runs on a LARA PC.
3. Wait for active checks and editors to finish. Follow the existing
   [idle maintenance procedure](DistributedOperations.md#perform-idle-maintenance).
   The website can serve locally while cluster mode is `off`; do not leave it
   stopped while waiting for access or copying large assets.
4. Back up the worker configuration and release link, apply the agreed editor
   policy, select the reviewed release, and restart the dedicated user service.
   Re-pin the controller's `executionProfile.bundleDigest` to that bundle.
   Preserve controller lineage, generations and attempt history.
5. Use the [maintenance CLI](DistributedExecution.md#configure-and-roll-out) to
   preload the exact official toolchain and public dependency manifests. Run
   fresh certification. `lean.session` is advertised only after the real pinned
   Lean server reports an invalid proof, accepts its correction, reads a mirrored
   save, and passes the actual container placement/resource checks.
   `prepare --preset mathlib` exports exactly the template environment used by
   playgrounds; a shared-dependency cache is a separate supported input. After
   certifying the worker with its supported native-check toolchain, preload
   Mathlib with `--certify false` to preserve that certification:

   ```sh
   node server/cluster/control.mjs prepare \
     --config /private/controller.json --data /coordinator/data \
     --image sha256:REVIEWED_IMAGE_DIGEST --node worker-a \
     --toolchain leanprover/lean4:v4.35.0-rc4 \
     --preset mathlib --certify false
   ```

   Use the exact pin in the reviewed release. Preloading a toolchain that does
   not support native checking must not replace a working native certification.
   `--preset mathlib` reads the toolchain directory from the coordinator's
   protected `runtime/toolchains.json`; it refuses a different supplied directory
   or manifest. Compare the preload's hashes with the `editor-assets-ready` audit
   entry or the startup log line `Editor environment ready`. Remote admission
   counts only nodes holding that exact warmed environment. The worker first
   runs a compiler with its ordinary check allocation, then requires invalid and
   corrected diagnostics and a saved-file read from the actual editor profile.
   It advertises the environment only after both containers have stopped and
   their temporary workspace has been removed. A failed qualification leaves
   ordinary certified checks available, with no slots for that environment.
   Preparation holds the node in maintenance while the compiler and LSP run;
   ordinary checks use other workers or the coordinator during that window.
   A CLI preset preload succeeds only when its exact configuration tuple is
   present in `editorEnvironments` and `editorEnvironmentReady` is true.
   Controller maintenance
   status shows configured capability limits; the public session capacity and an
   actual remote open are the acceptance checks for serving editors.

6. Keep mode `off` until enrollment checks pass. Then set
   `"editors": {"placement": "prefer"}` in the controller configuration and
   restore `mode: "serve"`. Restart the idle coordinator once, and verify its
   worker report, ordinary checks and remote editor placement. Installed asset
   identities survive controller reconnects; the new process need not transfer
   the environments again.
7. Run the acceptance tests below before raising the published user capacity.
   Remove temporary maintenance keys and verify that the production key still
   accepts only its fixed protocol commands. Preserve the separate maintenance
   route approved by the administrator, including an explicitly retained
   long-term maintenance key. Do not remove that key as temporary test cleanup.

The feature needs no new system package, extra public port, shared filesystem,
or provider key on the PC. It reuses the existing Docker image, dedicated account,
Node installation, SSH bridge, slice and AppArmor setup.

## Validate and operate

`node scripts/check-remote-editor-runtime.mjs` is an explicitly opted-in,
disposable Linux/container test. Set `STUDIO_ALLOW_RUNTIME_CHECKS=1`,
`STUDIO_TEST_WORKER_IMAGE=sha256:...` and `STUDIO_TEST_TOOLCHAIN_DIR` to an
installed official toolchain directory. It runs real Lean through the chunk/ACK
adapters without user projects or inference. Optional
`STUDIO_TEST_PUBLIC_ENVIRONMENT` and `STUDIO_TEST_TOOLCHAIN` exercise Mathlib;
the test copies that environment into its own directory and removes the copy.
Allow enough disk for the copy when reflinks are unavailable.

Unit coverage includes channel ownership, stream framing, source revisions,
save barriers, access changes, lease expiry, cleanup confirmation, preloaded
asset eligibility and shared editor/check accounting. These tests do not measure
production capacity. Use `scripts/check-editor-load-live.mjs` with disposable
ordinary accounts for real browser diagnostics, saves and mixed checks across
the installed machines. Inspect actual per-host placement, CPU, memory, OOMs,
capture latency, isolation and cleanup. Run the twenty-user case only when enough
workers are enrolled and accepted.

Run browser capacity tests on a Linux server with explicit resource limits.
Keep deployments and heavy acceptance runs on the server. Budget the load
generator separately from application workers; record when they share a host.
The accepted run used the matching
[official Playwright container](https://playwright.dev/docs/docker) at an 8 GiB /
two-CPU limit. A laptop-hosted attempt exhausted client resources and was excluded.

From a Linux checkout with `npm ci` completed, prepare a private ordinary-account
fixture in the format checked by
[`compile-load-fixture.mjs`](../scripts/lib/compile-load-fixture.mjs). Set absolute
paths in `LEANFLOW_LOAD_FIXTURE` and `LEANFLOW_LOAD_OUTPUT`, and explicitly set
`LEANFLOW_LOAD_ORIGIN` to the deployment being tested. Keep the fixture mode 0600
and its parent and output directories mode 0700. Match the image version to the
checkout's Playwright dependency:

```sh
docker run --rm --init --memory=8g --memory-swap=8g --cpus=2 \
  --pids-limit=2048 --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --shm-size=2g \
  --tmpfs=/tmp:rw,nosuid,nodev,size=2g,mode=1777 \
  --user "$(id -u):$(id -g)" --env=HOME=/tmp \
  --mount "type=bind,source=$(pwd),target=/work,readonly" \
  --mount "type=bind,source=$LEANFLOW_LOAD_FIXTURE,target=/fixture.json,readonly" \
  --mount "type=bind,source=$LEANFLOW_LOAD_OUTPUT,target=/output" \
  --workdir=/work --env=STUDIO_RUN_LIVE_LOAD_TEST=1 \
  --env=STUDIO_LOAD_USERS=15 --env=STUDIO_LOAD_FIXTURE=/fixture.json \
  --env=STUDIO_LOAD_OUTPUT=/output \
  --env "STUDIO_LOAD_ORIGIN=$LEANFLOW_LOAD_ORIGIN" \
  mcr.microsoft.com/playwright:v1.64.1-noble \
  node scripts/check-editor-load-live.mjs
```

Inspect actual container memory/CPU limits, peak memory and OOM events as well as
the browser report. Require worker placement, all diagnostics and distinct saves,
mixed checks and confirmed cleanup. Purge only the fixture's projects, revoke its
accounts and remove plaintext tokens after the run. Keep sanitized results in
the repository; retain private receipts separately.

### Measure concurrent full repository editors

Run this opt-in test on the coordinator after the enrolled workers have the
repository capability, the exact pinned environment, and enough approved slots.
Use an idle test window. The driver uses ordinary authenticated editor and
collaboration connections. It creates and permanently removes its own temporary
repositories and writes a private aggregate report for each scenario.

Set the origin, live data directory, exact enrolled worker IDs and toolchain
for your deployment. The account setup command creates 20 disposable ordinary
accounts. Keep their generated token manifest in the private directory.

```sh
export STUDIO_RUN_LIVE_LOAD_TEST=1
export STUDIO_LOAD_ORIGIN=https://your-leanflow.example
export STUDIO_LOAD_DATA_DIR=/path/to/leanflow-data
export STUDIO_LOAD_TOOLCHAIN=leanprover/lean4:v4.35.0
export STUDIO_LOAD_WORKERS=worker-a,worker-b,worker-c
STUDIO_LOAD_OUTPUT=$(mktemp -d)
export STUDIO_LOAD_OUTPUT
export STUDIO_LOAD_FIXTURE="$STUDIO_LOAD_OUTPUT/accounts.json"
node scripts/repository-editor-load-accounts.mjs prepare
node scripts/check-repository-editor-load-live.mjs distinct
node scripts/check-repository-editor-load-live.mjs shared
node scripts/repository-editor-load-accounts.mjs clean
```

The first case uses 20 separate repositories. The second uses independent
proof files in one shared repository. Both hold all 20 connections open.
Every participant must receive real Lean diagnostics and an interactive goal,
see a different collaborator's saved helper declaration take effect in their
dependent proof, and read their own saved proof back from the server. The
report counts any document reopen equivalent to **Refresh imports**. The same
Lean connection must remain live. A waiting editor cannot complete the test.

The driver checks actual local `lake serve` containers and running, project-
and account-matched remote repository receipts twice, then verifies cleanup.
Its report records the effective account, project and overall admission
limits. Set `STUDIO_LOAD_PRESET=mathlib` to repeat the scenarios for an exact
prepared Mathlib configuration. A two-account private loopback fixture can run
the same protocol with `--local-probe`. That result records its two-user scope.
The existing browser checks cover the client UI separately.

Each session owns one SSH channel and a leased attempt. Output is acknowledged
in bounded chunks; LSP text is not persisted in the check-event journal. The
session ends when its browser closes, its channel fails, its lease expires or
its six-hour deadline is reached. Unconfirmed cleanup holds the grant and
quarantines placement until reconciliation. A worker restart reaps its old
owned containers and disposable workspaces. It earns fresh native certification
and repeats the compiler/editor checks for its previously prepared public
environments before advertising their editor slots. Qualification is tied to the
current worker process epoch; a persisted success alone cannot restore capacity.
Image changes, recertification and cache removal invalidate existing qualification.
The entire node remains unavailable during restart certification and environment
qualification. Measure that window; the coordinator continues local serving.
Startup removes abandoned warm-up copies, their dependency bindings and homes
after reaping the node's owned containers. An unconfirmed container cleanup
quarantines the worker; an ordinary qualification failure removes only the
affected editor environment.

Cache/history maintenance requires drained sessions as well as drained checks.
Coordinator asset capture runs once per startup. If the preset/toolchain is missing or being rebuilt,
correct preparation and permissions, finish preloading, then restart the idle
coordinator to retry it. Until then, local serving remains available.
Use the existing bounded store budgets and scheduled idle maintenance. For
rollback, set editor placement to `off`, drain work, restore the previous reviewed
worker release/configuration and its bundle pin, and re-certify. Preserve the
controller database rather than restoring an older generation.
