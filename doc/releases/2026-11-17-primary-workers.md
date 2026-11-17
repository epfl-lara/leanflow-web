# 32 editor slots across four machines

The coordinator now enables PC05, PC06 and PC2 during normal serving. PC2 is a
limited primary worker. Canonical projects, authentication, collaboration and
databases remain on the VM. General project storage on the PCs remains deferred.

## Installed allocation

| Host                    | Managed editors | Editor cap    | Application pool                   | Compile capacity retained                |
| ----------------------- | --------------: | ------------- | ---------------------------------- | ---------------------------------------- |
| `icvm0135.xaas.epfl.ch` |               9 | 3 GiB / 2 CPU | 45 GiB; 8 physical CPUs            | 18 GiB native-check reserve              |
| `larapc05.epfl.ch`      |               9 | 3 GiB / 1 CPU | 45 GiB / 15 CPU; 12 weighted slots | 18 GiB / 6 CPU, or three ordinary checks |
| `larapc06.epfl.ch`      |               9 | 3 GiB / 1 CPU | 45 GiB / 15 CPU; 12 weighted slots | 18 GiB / 6 CPU, or three ordinary checks |
| `larapc2.epfl.ch`       |               5 | 3 GiB / 1 CPU | 21 GiB / 7 CPU; 6 weighted slots   | 6 GiB / 2 CPU ordinary check             |

The total admission limit is **32 managed editors** when all workers and their
public environment are ready. It counts active language servers, not people
merely viewing the site. Each account and project retains its three-editor
limit. Larger repository editors use the VM's ordinary allocation and can reach
its memory limit sooner. Agents and terminals remain on the coordinator.

PC05/06 stay inside their administrator-installed 48-GiB / 16-CPU slices,
leaving 3 GiB / 1 CPU outside each application pool. PC2 stays inside its
24-GiB / 8-CPU slice, leaving 3 GiB / 1 CPU. All three slices enforce zero swap
and 8,192 tasks. The worker user services keep their separate 2-GiB / 2-CPU caps.
These are shared hosts; no system limits, Docker backend or administrator
sessions were changed.

Nine editors on PC05/06 reserve 27 GiB / 9 CPU, leaving a full native check.
Five editors on PC2 reserve 15 GiB / 5 CPU, leaving an ordinary check. PC2 also
supports native checks when enough of its pool is free. It contributes to
normal scheduling rather than waiting as a reserve node.

## Release and image identity

The deployed coordinator is `35e77d94b099d8e85405f47b40774228245660e5`.
Its 185 production helper files match the server-tested source. The existing
client assets and native Lemex binaries are unchanged from the newer EPFL
sign-in release, `ee9d2feaf593f71518dc5f4f8c7bc4f0d806adb8`. Provider settings,
existing accounts, controller lineage and databases were preserved.

All three PCs retain the separately reviewed protocol-2 worker bundle
`cc7080df981d0ddb00c30c0d8b511b53e4c245c4b82a96b76843b2753a70ddb2`,
from source `7dfb78aec33f54f1ce1483e30c069b020cbdb0b8`. Its retained archive
checksum is `58ad39acea428b2778243e071edb4c2d25c646d443602c9c8d53b092692872ec`.
A coordinator website update does not implicitly replace these workers.

The same worker image export has different local IDs in the two Docker stores:

| Hosts          | Store              | Exact enrolled local image ID                                             |
| -------------- | ------------------ | ------------------------------------------------------------------------- |
| VM, PC05, PC06 | containerd         | `sha256:0ef38c7e4ec01c43f82152aee50557730180111413a51dd01418aaf741c2a85d` |
| PC2            | classic `overlay2` | `sha256:ec76fa04d265ca44e66bb25fff099daf38d3f0d9d61802c2e11322532c18dab6` |

The transferred archive's SHA-256 is
`ced11599bd4d208f15f51b31f6ccc5baa21c635af55eeb09c9048de7cb247d1d`.
Its actual configuration blob hashes to the PC2 ID. Both imports verified the
archive; Docker verified its layers. Only PC2 has a controller-entry
`imageDigest` override, matching its worker's `image`. Both handshakes,
placement, image loading, grants and result fences enforce the selected pin.
An unrecognized image remains unavailable. See the
[image-store enrollment procedure](../WorkerExpansion.md#keep-image-pins-exact-across-docker-image-stores).

## Host enrollment

Fabien prepared both accounts and upgraded PC2 to Ubuntu 26.04. Both new hosts
had inherited PC06's node ID, protocol key and bridge. PC2's copied bridge also
contained UID 1001, while its actual account UID is 1003. Both new bridges now
use the existing generated handoff template, which discovers the UID and home.

Each host now has its own node ID and restricted protocol key. Fresh protocol
and maintenance connections work. Both new protocol keys reject shell commands,
and the cloned PC06 key is rejected on both hosts. Administrator keys and the
approved long-term maintenance key were preserved. No AI agent runs on a PC.
Deployment uses fixed reviewed commands from the coordinator and user-directory
services; project code runs inside the bounded containers.

Only the known public cache closure was copied: 188,640 content-addressed
objects totaling 13,484,338,570 bytes. Each imported object was SHA-256 checked.
No worker database, controller identity, private project tree or whole state
directory was copied. The seed occupies less than half of both the 64-GiB /
500,000-object budgets, leaving room for checks. Materialized runtime trees
remain separate copies. The workers retain a 64-GiB free-space floor; these
application limits do not create filesystem quotas on a shared Docker daemon.

Existing `WorkerNode` leases, materialization and conformance code prepared the
disabled hosts. Maintenance SSH carriers kept their user managers alive during
staging. For a repeated import, hold the normal data-directory lease and keep
the user service stopped throughout. Use the existing home-directory
maintenance condition when preventing automatic service startup.

All four capabilities passed on each new host: `check.build`, `lean.file`,
`check.kernel` and `lean.session`. Certification exercised valid/invalid Lean,
native kernel verification, enforced AppArmor, container boundaries, isolated
OOM recovery, real editor diagnostics and saved-file readback. The native
toolchain is `leanprover/lean4:v4.35.0`.

The qualified public editor tuple is:

- Toolchain: `leanprover/lean4:v4.35.0-rc4`, manifest
  `081f8cb2fb69e2b6ac5e45b0e9aabd4994a04372388c1c00f679b70d8b9d49c5`.
- Dependencies: `b6874cdcbadfb2529dce414270d230da4ec5de717f6c0c4979123ca3fae16693`.
- Fixed editor source: `2a675323ecd19a239f7e7da1766bf0e021308ed8d8b580067c8c3f0e57197137`.

Both services passed restart and protocol reconnect checks with new process
epochs and fresh environment qualification. A full last-login logout cycle was
not forced: another administrator session was present on PC05. Production SSH
connections keep the user managers alive; the bridge starts the user service
when reconnecting.

## Validation

Claude Opus 5.5 at maximum effort reviewed the plan, coordinator change and
cutover procedure. Findings addressed image-store identity, copied bridge UID,
save throttling in the test client, result fences, resource arithmetic and
rollback guards. The cutover first waited for active work. Lazar then approved
a brief restart for editor reconnection; proof jobs and terminals remained
protected by the deployment guard.

- Full server-side checks: TypeScript, lint and 2,246 executed tests passed;
  two optional tests skipped. Final focused coverage: 52 passed, including
  mixed image stores, swapped-pin rejection, image loading, result-fence
  rejection and the native-check resource reserve.
- The VM production build passed with a bounded 6-GiB / 2-CPU build process and
  a 4-GiB JavaScript heap. The first isolated 3-GiB build hit its heap limit.
- A one-account server-side protocol preflight passed real type-error
  diagnostics, correction, exact canonical-file readback by Lean and native
  compilation. The test matches the actual error rather than assuming that
  Lean prints `Nat` instead of `ℕ`.
- Thirty simultaneous ordinary-account editors passed real errors, corrections,
  distinct canonical saves, exact saved-file reads by Lean and account
  isolation. Placement was 9 PC05 / 9 PC06 / 5 PC2 / 7 VM, independently
  observed 56 times. All 15 native and 15 Mathlib checks completed while the
  same editors stayed connected; the burst took 72.2 seconds.
- The separate 15-browser run passed token login, real error/correction
  diagnostics, distinct durable saves, account isolation and 15 mixed checks
  with editors held. The compilation burst took 36.94 seconds. Both accepted
  runs had zero premature WebSocket closes and zero unhandled test errors.
- Fresh native application checks completed on every PC, including PC2's
  classic-store image. A fresh post-load ordinary session passed native
  verification and a remote Mathlib error/correction/save/readback cycle.
- All worker OOM deltas were zero after certification; no attempts, containers,
  warm-up directories or warm-up registry bindings remained. The generators
  peaked at 83.5 MiB for the protocol test and 7.185 GiB for the browser test,
  with zero generator OOM events.
- Protocol API probes had p95 4.87 ms and maximum 15.97 ms. Browser-driver
  probes had p95 189.93 ms and one 22.79-second outlier. The browser timings
  include fifteen renderers and full-buffer input on two CPUs; the outlier is
  retained without attributing it to client or server. Initial real type-error
  responses in the protocol test took 13.25–28.88 seconds. Correction, save and
  exact Lean readback took p95 2.01 seconds. Thirteen throttled saves retried
  successfully using `Retry-After`.
- GitHub's Node 24 and Node 26 jobs passed. The broader workspace browser job
  found a pre-existing timing race: the Git test observed the publication notice
  before asynchronous status refresh removed its review panel. The test now
  waits for that panel to detach. Its isolated Git browser run passed.
- All 60 fixture projects were permanently deleted, all 30 fixture accounts
  were revoked, and their plaintext token files were removed. The separate
  fresh smoke account and its two projects were also purged.

The initial 30-slot run reached 28 test editors before a real 6-GiB repository
editor reconnected and consumed a larger VM allocation. The guards refused the
next test editor. Raising PC05/06 from eight to nine editors retained the full
native reserve inside the same administrator limits. Both rolling worker
restarts re-qualified successfully, with public capacity rising to 31 and 32;
the coordinator process stayed running. Additional active work later ended
naturally. No full-slice allocation was applied.

An earlier accepted-editing phase was stopped by an observer race when a short
check container exited between listing and inspection. The observer now tolerates
that normal exit and cleans stopped generators. The complete run above was
repeated after that fix; partial runs are not counted as acceptance.

The [machine-readable receipt](data/2026-11-17-primary-workers.json) contains
the measured results and explicit limits of these claims.

The 30-session test uses ordinary disposable accounts and real WebSocket/LSP
processes, with 120 `norm_num` theorems per Mathlib project and 400 native
associativity theorems per native project. A private VM observer checks actual
worker grants and local runtime counts while all editors are held. The
generator is bounded to 1 GiB / 1 CPU. The separate browser run uses 15 contexts
in an 8-GiB / 2-CPU container. Neither runs on the laptop. No provider inference
API is permitted by the protocol test's endpoint allowlist.

Thirty protocol sessions and fifteen browser contexts are separate acceptance
claims. They do not claim thirty browser processes on the VM or thirty parallel
AI agents. The admission limit follows ready workers; a failed or unqualified
worker stops contributing slots.

## Maintenance

The live configuration remains in the coordinator's protected cluster
configuration. Preserve its lineage and per-node transport/image pins. Drain
work before restarting a worker or changing its profile. Stop the coordinator
under the shared deployment lock for a coordinator release/configuration
cutover; never start another controller against a copied live database.

On the installed user-service setup, the private `leanflow/maintenance` file
prevents automatic service startup. An emergency worker withdrawal can create
that marker and stop its user service through the approved maintenance route.
Remove only the marker you created before restarting and re-qualifying the
worker. Do not remove administrator or long-term maintenance keys.

Rollback restores the previous coordinator release/configuration only after
checking for new work. Never restore an old controller database. A coordinator
without per-node image pins cannot use PC2; the other workers remain available.
PC06's enlarged policy is compatible with the retained worker bundle and must
also be drained before changing it back.
