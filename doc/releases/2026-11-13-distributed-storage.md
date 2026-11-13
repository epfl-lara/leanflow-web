# Distributed storage deployment, 13 November 2026

The asset-reference implementation was deployed from
[`844aee4`](https://github.com/epfl-lara/leanflow-web/commit/844aee45d762ff2b7f9da421acb2a68a74a7e627).
It retained the reviewed protocol-2 worker release and image. The website serves
remote native checks through the enrolled primary. Additional primary and
reserve machines remain unenrolled or disabled; their resources are excluded
from verified serving capacity.

## Current topology and limits

| Deployment label | State                           | Role                                                                                |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `icvm0135`       | Serving                         | Website/coordinator, saved work, databases, interactive workloads and local checks  |
| `larapc06`       | Enabled and serving             | Dedicated `leanflow` service account; pure remote checks and local execution caches |
| `larapc05`       | Configured but disabled         | Additional primary; administrator preparation and enrollment still required         |
| `larapc2`        | Requested reserve, not enrolled | Excluded from the normal pool; `allowReserve` is false                              |

Host addresses, SSH key paths and credentials are deployment configuration, not
portable installation defaults. Read the protected `STUDIO_CLUSTER_CONFIG` on
the coordinator for enrolled endpoints. The public entry point is
[LeanFlow](https://leanflow.epfl.ch/).

The active remote job pool admits eight CPUs and 24 GiB, with four ordinary
two-CPU/6-GiB slots. A native check takes three slots/six CPUs/18 GiB and is
limited to one per host. The installed [user-service template](../../deploy/leanflow-node-user.service)
sets a separate two-CPU/2-GiB daemon limit. The outer
container slice is 16 CPUs/48 GiB with swap disabled. These limits preserve the
approved shared-host boundary; they do not describe four simultaneous users.

The coordinator transfer cache is capped at 32 GiB/500,000 objects, with an
8-GiB free-space floor. The source index has a separate 500,000-row bound.
Worker volume space remains shared with its host; application budgets are not
a filesystem quota or a promise of dedicated disk capacity.

The unchanged execution profile is:

```text
protocol: 2
worker source: 3ba50d31a22c4bc99a191909b7432f287bda3372
worker bundle: 27c56ca144377223a60761e837fbc8b33c8c7b5bb433f77ad9b420fe7528448f
worker image: sha256:0ef38c7e4ec01c43f82152aee50557730180111413a51dd01418aaf741c2a85d
native runtime: Lemex 0.1.5
```

No image or worker-host code update was needed for coordinator deduplication.
The retained pre-index release `18b48fa` must use cluster mode `off` if restored
after trimming. Reference-aware `844aee4` supports serving from the source index;
keep it as the rollback for the documentation/test follow-up release.

Operational paths are relative to the coordinator's configured data directory:

| Path or unit                                             | Purpose                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `cluster/config.json`                                    | Protected controller configuration, enrolled endpoints and pinned profile                              |
| `cluster/cluster-controller.sqlite`                      | Authoritative lineage/generations and attempt receipts; never clone for a second controller            |
| `cluster/blobs/asset-sources.sqlite`                     | Private hash-to-original source index                                                                  |
| `runtime/elan/toolchains`, `runtime/shared-dependencies` | Canonical protected backing files; preserve them after trimming                                        |
| `releases/COMMIT`                                        | Immutable website releases with native-runtime link and release manifest                               |
| `cluster/storage-cache-20261113`                         | Private cutover, source-hash, backed-read/upload, live-proof and cleanup reports plus database backups |
| `leanflow-web.service`                                   | Coordinator user service; check its `WorkingDirectory` for the active release                          |
| `leanflow-node.service`                                  | Dedicated worker account's user service; source/configuration live in its approved local home          |
| `leanflow-workers.slice`                                 | Administrator-owned outer container boundary                                                           |

Raw report names include `storage-cutover.json`, `source-index-sha-verified.json`,
`backed-read-live.json`, `live-backed-upload.json`, `live-serve-api.json` and
`cleanup.json`. Read them privately on the coordinator; do not commit databases,
credentials or user content. The production worker key remains protocol-only,
and the temporary worker maintenance key was revoked.

## Finish the additional primary and reserve

An administrator must prepare `larapc05` before it is enabled:

A fresh read-only preflight found no `leanflow` account, no Node executable at
the expected managed path, an inactive container slice and no supplied AppArmor
profile. The ordinary SSH account cannot complete those system prerequisites.

1. Provide the dedicated local service account, persistent local home, Docker
   access, Node.js 24 or newer at an approved absolute path, Python and OpenSSH.
2. Approve shared-host CPU/RAM/disk limits; install the supplied container slice
   and AppArmor profile. A volume's free space is not a dedicated allocation.
3. Use the [user installation procedure](../UserExecutionWorkers.md), install
   the reviewed source/image and configure a per-worker restricted SSH key with
   verified host keys. Keep all private keys on the coordinator.
4. Prepare pinned toolchains/dependencies and run current-process conformance,
   valid/invalid fixtures, cancellation and representative native checks.
5. Compare in shadow mode, then enable the primary for `serve` only after those
   checks pass. Do not count its resources beforehand.

Enroll reserve hosts separately with `role: "reserve"`; activate them only
under an explicit availability policy. This deployment did not prepare PC 2 or
enable automatic failover. Broader load tests and provider/coordinator limits
must guide future pool increases, rather than a fixed user-count target.

## Storage result

- Verified all 337,075 indexed originals by SHA-256 before cleanup:
  22,437,383,674 bytes across two toolchains and public dependency assets.
- Removed 337,075 duplicate coordinator payloads with zero skipped backings.
  Physical transfer objects fell to approximately 800 MB. Recapturing indexed
  environments does not add another payload copy.
- Filesystem free space increased from 81,882,009,600 bytes immediately before
  cutover to 105,443,426,304 bytes after staging cleanup: approximately 22 GiB
  recovered and 98 GiB free. Normal activity and later releases change this
  measurement.
- Preserved canonical projects, databases, retained work, runtime assets and the
  previous website release. No authoritative data was relocated to workers.
- Indexing existing legacy immutable assets did not upgrade their cache
  certificates or change which environments qualify for remote checking.

## Validation

- Claude Code, configured Opus 5.5 with maximum review effort, reviewed the
  implementation and follow-up changes: no high/medium findings and final
  verdict "Go. No blockers."
- Combined Linux suite: 1,889 passed, one skipped, zero failures. Typechecking,
  lint, formatting and client build passed. GitHub's Node 24/26 and security
  checks also passed.
- The complete [GitHub CI run](https://github.com/epfl-lara/leanflow-web/actions/runs/43463214496)
  passed on its second attempt. The first workspace job timed out in the
  isolated Alt-hover navigation fixture; the rerun passed. Browser chat passed
  on the first attempt. The later test-only update uses line-relative locator
  input instead of stale absolute mouse coordinates and passed three complete
  isolated navigation runs without weakening assertions.
- Live backed reads sampled one file from each of the five populated indexed
  roots with payload copies absent. A separate 32-KiB protected transfer fixture produced a cache-miss
  upload/readback through the installed worker's restricted bulk protocol; it
  was not installed as a Lean toolchain or used as proof evidence.
- Valid and invalid native API checks both recorded `remote-completed`, with
  exit codes zero and one. No model provider was called. The disposable project
  was permanently removed after verification.
- The worker-process epoch survived cutover. Controller lineage was preserved
  and its generation advanced monotonically. No worker cache reset, maintenance
  shell or worker-host AI agent was used.

This repository records topology, limits, profile, administrator prerequisites,
measurements and acceptance. Private raw audit files retain database backups,
job receipts and installation logs; keys and tokens are never committed. Use
the [operations guide](../DistributedOperations.md) for maintenance, scaling,
acceptance and rollback. Artifact replication, distributed interactive work and
coordinator high availability remain future work; this release does not establish
a simultaneous-user capacity benchmark.
