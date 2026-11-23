# Lean and worker cache reuse

LeanFlow reuses Lean's compiled libraries, Lake's build artifacts and the
existing content-addressed worker store. It does not introduce another build
system or share mutable Lean sessions between accounts.

## What stays warm

- Pinned toolchains and dependency trees are installed once on each worker.
  Containers mount them read-only. Their `.olean`, `.ilean`, `.olean.private`,
  `.olean.server`, `.trace` and hash files retain their timestamps. Containers
  on the same host can share the operating system's file cache.
- In a shared repository project, one successful build of a saved module
  supplies its `.olean` files to everyone working in that project. For
  example, if Alice and Bob open different files importing `Common`, Lake
  builds a changed `Common.lean` once. Both editors read the completed
  artifacts. Each editor still checks the file its participant is editing.
- Editors, import rebuilds and local project checks coordinate writes to the
  same build directory. Saving remains available during compilation. A save
  during a build invalidates the affected output, even if the edit is undone.
  The next build also recovers after an interrupted compiler. A cold import
  needs a free build slot. Already compiled modules remain available to editors.
- The coordinator references protected managed files in place. It keeps a
  persistent index of their content hashes rather than duplicating their bytes
  in another VM cache. Workers receive only missing content hashes; interrupted
  transfers resume and concurrent sends of an object share one upload.
- A ready worker advertises its installed environment. A new coordinator uses
  that current-epoch inventory instead of scanning every dependency object over
  SSH again. The worker still confirms `assets.prepare`. Missing assets trigger
  one full upload and preparation retry before execution starts.
- The same editor keeps its Lean process and incremental snapshots while
  editing and saving. Hidden Monaco models are retained within existing bounds.
  Thirty minutes without user activity releases the Lean connection and memory.
  Reopening or waking an editor starts a fresh process using the installed
  libraries. No cross-account language-server state is reused.
- Existing prepared-preset and shared-dependency certificates include their
  pinned configuration, toolchain and worker image. Changing those inputs
  requires preparation and validation again. Public editor qualification also
  belongs to the actual worker process epoch.

The upstream mechanisms are [Lake's build traces](https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Lake/)
and [Mathlib's prebuilt artifact cache](https://github.com/leanprover-community/mathlib4/blob/master/Cache/README.md).
LeanFlow preserves those artifacts instead of recompiling the libraries for
each editor. General project storage on worker PCs remains a separate proposal.

## Coordinator improvements, November 17

Concurrent cache misses now share one read, checksum, JSON parse and manifest
validation. Failed loads can retry. Different expected manifest kinds retain
their own read limits and validation. The existing 64-MiB manifest LRU remains
bounded; a separate 64-entry set retains only successful immutable asset
validation keys, so alternating environments need not repeatedly parse large
manifests. It does not retain another copy of their entry arrays.

After a coordinator restart, protected managed files can reuse the existing
asset index's hash when device, inode, size, nanosecond modification/change
times, ownership, permissions and link count still match. Capture still opens
each file without following symlinks and checks its identity afterwards.
Replaced or changed files are hashed again. Mutable project files never use
this optimization. Capture counters report hashed/reused files and bytes
outside the sealed manifest; the snapshot digest and protocol are unchanged.

Slow immutable captures run separately from source-capture admission. Their
lifetime belongs to the service: one user's cancellation stops that user's
wait, rather than destroying shared preparation. An ordinary check whose
assets are not ready uses the existing local execution path while preparation
continues. Clearly unsupported checks return locally before creating a source
snapshot. Failed preparation has a five-minute retry cooldown. Shutdown cancels
and drains the shared preparation work, including waiting for Python helpers to
actually close after cancellation. The controller keeps its storage lease until
those helpers have stopped, so a replacement cannot race their final writes.

Upload history evicts its oldest entry instead of clearing the whole history.
Running editor attempts use a two-second status interval rather than the
batch-check interval of 500 ms. LSP input/output uses its existing direct
stream; cancellation wakes cleanup immediately. A worker reporting
`storage_full` before an attempt starts is withdrawn briefly and permits local
fallback, with its resource grant released. Failed or uncertain running work
never receives this fallback.

## Measured results

These are isolated component measurements on the VM, bounded to 3 GiB and two
CPUs. They compare the previous implementation with the changed implementation;
they are not promises about browser response time.

| Operation                                                             |          Before |          After |
| --------------------------------------------------------------------- | --------------: | -------------: |
| Eight concurrent requests for the 38.5-MB dependency manifest         | 8 reads; 8.59 s | 1 read; 1.18 s |
| Process RSS after that manifest load                                  |       734.6 MiB |      171.2 MiB |
| Thirty subsequent warm manifest reads                                 |    0 disk reads |   0 disk reads |
| Capture the unchanged public dependency tree, 146,241 files / 7.54 GB |         34.20 s |         9.49 s |

Both dependency captures produced the same snapshot digest. The new capture
reused hashes for 146,220 files / 7,539,258,323 bytes and hashed 21 files /
191,484 bytes. The compiled environment contains 9,043 `.olean` files, 9,043
`.ilean` files, 9,042 each of the private/server `.olean` companions, and 9,090
traces. The [machine-readable measurements](releases/data/2026-11-17-cache-reuse.json)
retain the exact values.

The combined server-side suite passed 2,266 tests with two optional skips.
Regression coverage includes concurrent misses, retry after failure, kind/size
limits, source changes, private files, restored timestamps, atomic replacements,
shutdown/cancellation, installed-worker reuse, cache eviction and safe pre-start
fallback. All builds and checks run on the VM.

Reproduce manifest contention with the checked-in helper on a test server:

```sh
node scripts/profile-cluster-manifests.mjs \
  --store /path/to/copied-store \
  --hash b6874cdcbadfb2529dce414270d230da4ec5de717f6c0c4979123ca3fae16693 \
  --kind dependencies --callers 8
```

The directory needs an `objects/DIGEST` copy of the public manifest. The helper
does not initialize a database, controller or worker and makes no network
requests. Run it with bounded memory/CPU; use separate processes for before
and after measurements.

## Deployment and remaining costs

These coordinator changes preserve protocol 2 and the separately pinned
`cc7080...` worker bundle. The website can reuse its unchanged client assets,
production dependencies, native runtime, Docker image and the PCs' installed
environments. Keep maintenance SSH sessions across a coordinator restart so
the workers' user managers do not stop and repeat qualification unnecessarily.
Release those temporary connections after normal production connections resume.

Each independent Lean server still imports libraries and elaborates its user's
source. The earlier 13–29-second load-test diagnostics included 120 `norm_num`
theorems and editor arrivals in groups of three; they did not isolate import or
transfer time. The roughly two-second correction/save/readback p95 included
save-throttle retries. See the [30-editor acceptance record](releases/2026-11-17-primary-workers.md).

Fresh proof checks reuse compiled dependencies but retain independent source
and kernel validation. Each proof check produces its own verdict. A project's compiled modules stay
with that project on the coordinator. Remote playground editors reuse the
public libraries installed on their worker.
SSH channel pooling and lighter worker bridges need measurements before a
worker upgrade. Selective object retention is still future work; monitor the
bounded stores rather than routinely clearing installed environments with a
full cache reset.
