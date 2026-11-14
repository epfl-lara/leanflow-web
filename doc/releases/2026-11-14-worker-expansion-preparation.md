# Additional primary workers — preparation on 2026-11-14

**Prepared, not activated.** larapc05 and larapc2 need administrator prerequisites
before they can serve LeanFlow. Both are planned as primary workers; larapc2 has
a smaller fixed allocation. The active coordinator and larapc06 remain in service.

## Verified inventory

Read-only SSH inspection used the existing ordinary accounts. No AI agent was
run on a worker and no privilege escalation or system changes were attempted.
These free-space and availability observations are time-specific.

| Host        | Logical CPUs / RAM | Local storage observed                                                                         | Current prerequisites                                                                                                                |
| ----------- | ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Coordinator | 8 / about 61 GiB   | Existing coordinator data volume                                                               | Website active; four LSP connections; seven total local worker slots                                                                 |
| larapc05    | 16 / about 61 GiB  | `/localhome` backed by `/data`, about 726 GiB free; ordinary home is NFS                       | No `leanflow` account, Docker, `/opt/node`, worker slice or kernel profile                                                           |
| larapc06    | 16 / about 61 GiB  | Existing local worker home and Docker storage, about 731 GiB free                              | Existing approved worker; unchanged                                                                                                  |
| larapc2     | 28 / about 63 GiB  | `/localhome` backed by `/data`, about 1,061 GiB free; separate `/storage` about 2,731 GiB free | Docker 29.4.3, systemd cgroup driver, cgroup v2 and AppArmor already present; missing account, `/opt/node`, slice and kernel profile |

larapc2's shared Docker store uses the classic `overlay2` backend at
`/var/lib/docker`, bind-mounted from `/data/docker`, with about 1,060 GiB free.
Preserve its installation and existing containers; confirm its disk/inode policy.
Its existing `/storage` archives are outside this work.
No existing data is being moved to make a worker.

Both target SSH ports are reachable from the coordinator. Host keys were
obtained through existing strictly checked SSH connections from the operator's
machine. Account login and PAM/user-manager behavior still require verification
after administrator setup.

## Requested allocations

| Host     | Role after acceptance           | Initial admitted CPU / RAM | Outer container CPU / RAM | Native checking                                         |
| -------- | ------------------------------- | -------------------------- | ------------------------- | ------------------------------------------------------- |
| larapc05 | Primary                         | 8 CPUs / 24 GiB            | 16 CPUs / 48 GiB          | One native check; room for one ordinary job alongside   |
| larapc06 | Existing primary                | Existing 8 CPUs / 24 GiB   | Existing 16 CPUs / 48 GiB | Existing one-per-host policy                            |
| larapc2  | Primary with smaller allocation | 6 CPUs / 18 GiB            | 8 CPUs / 24 GiB           | One native check; ordinary jobs use at most three slots |

The limited pool is large enough for the existing native-check resource vector,
while leaving most of larapc2's CPU and memory for other work. These admission
budgets are proposed policy, not a benchmark or a dedicated claim on the entire
host. Twenty active editors remain an application milestone; see
[the preparation and acceptance plan](../WorkerExpansion.md).

These are proposed allocations. In particular, larapc2 has not passed real
native-check acceptance. Its entire pool is needed for one native check, so
representative workload and fairness tests are required before counting it.

## Concrete handoff

The private administrator package contains a host-specific slice, the exact
AppArmor policy, private node configuration, user service, fixed bridge,
separate protocol/bootstrap public-key lines, trusted host pin, disabled
controller entry, the matching source archive and checksums. Private SSH keys
remain on the coordinator. No account token, provider key or private SSH key is
included in the handoff or this repository.

The archive reuses the already deployed worker release rather than the newer
website helpers:

- Source revision: `3ba50d31a22c4bc99a191909b7432f287bda3372`.
- Protocol: 2.
- Helper bundle: `27c56ca144377223a60761e837fbc8b33c8c7b5bb433f77ad9b420fe7528448f`.
- Image: `sha256:0ef38c7e4ec01c43f82152aee50557730180111413a51dd01418aaf741c2a85d`.
- Source archive SHA-256: `a430a741257b06e825bbeee97849ad96fa318dfbd2e51ecfbc90c8522ebc9c17`.

New deployment bootstrap keys expire at **2026-11-21 12:00 UTC**, and must be
removed earlier after setup. They allow reviewed deployment commands; the
separate production keys remain protocol-only. The administrator may instead
install the supplied home-directory files without granting bootstrap access.
An approved administrator maintenance path must remain available for upgrades.

The coordinator's lineage and active execution profile were preserved. larapc05
remains disabled and larapc2 has not been inserted into active configuration.
No controller was initialized and no service was restarted. Existing work was
observed on the coordinator, so no admission or resource limits were changed.

## Review and verification

Claude Code (Opus 5.5, maximum effort, read-only) confirmed that the admission
arithmetic is consistent. Its rollout corrections are included in the guide:
global `off`/exclusive-controller maintenance, reconnect/autocertification,
explicit parent limits and scratch, conditional native acceptance on larapc2,
and SSH/PAM plus Docker image-store/storage checks. The website can serve local
work during an `off` phase, but larapc06's remote capacity is paused too.
New hosts must be enabled in the offline maintenance configuration to certify
them; initial handoff entries remain disabled pending that controlled step.

The five focused preparation tests pass, covering exact archive/source pins,
key separation/expiry, disabled primary entries, resource-vector admission,
altered source and forbidden archive entries. The actual reviewed source was
also used to generate both host requests. TypeScript and lint checks pass
(existing lint warnings remain outside the new files).

The broad macOS unit run encountered existing Linux `/proc/self/fd` dependencies
and could not complete. The unchanged managed-file tests independently reproduce
seven failures on base `25e5fc7`; only this task's stalled test process family
was stopped. No runtime or platform-portability changes are part of this prep.
Full Linux CI remains the repository gate.

## Message for the administrator

> Could you prepare **larapc05** and **larapc2** for LeanFlow using the attached
> host-specific files? Both should be regular workers, with a smaller allocation
> on larapc2.
>
> Please create local `leanflow` accounts at `/localhome/leanflow`, grant Docker
> access, and provide Node 24+ at `/opt/node/bin/node` plus Python 3, tar and SSH.
> larapc05 needs Docker installed; larapc2's existing Docker and data should stay
> in place. Install the supplied system slice and kernel AppArmor profile:
> **05: 16 CPUs / 48 GiB outer ceiling; pc2: 8 CPUs / 24 GiB**, zero container
> swap. Initial job pools will be smaller: **8 CPUs / 24 GiB** and **6 CPUs /
> 18 GiB**, respectively.
>
> Please confirm local disk/inode boundaries including Docker storage, and
> append each host's temporary bootstrap key from its attachment (expires
> **21 November, 12:00 UTC**), preserving existing keys. We will install the
> remaining files in the dedicated homes, verify isolation, then remove bootstrap
> access and retain only the forced-command production keys. If preferred, you
> can install the user files instead. Please retain an administrator maintenance
> path; enabling linger for these accounts is optional for boot-time availability.
> No AI agent will run directly on either host, and no new public port is needed.
