# Prepare additional shared workers

Generate a private administrator handoff before changing a machine. The
`standard` and `limited` allocations both make **primary** workers. A limited
worker contributes during normal service; it is not a reserve. Generated
controller entries remain disabled until installation and acceptance pass.

This adds pure check capacity through the existing restricted SSH protocol.
Live Lean editors, agents, terminals, project setup, canonical files and SQLite
remain on the coordinator. Adding these workers does not raise the editor cap.
Use [the expansion record](releases/2026-11-14-worker-expansion-preparation.md)
for the actual machine inventory and current rollout status.

## Choose the initial allocation

| Allocation | Admitted jobs CPU / RAM | Ordinary slots | Native checks                       | Outer container CPU / RAM / tasks |
| ---------- | ----------------------- | -------------: | ----------------------------------- | --------------------------------- |
| standard   | 8 CPUs / 24 GiB         |              4 | One, plus room for one ordinary job | 16 CPUs / 48 GiB / 8,192          |
| limited    | 6 CPUs / 18 GiB         |              3 | One, using the whole admitted pool  | 8 CPUs / 24 GiB / 4,096           |

An ordinary check reserves 2 CPUs and 6 GiB. A native check reserves three slots,
6 CPUs and 18 GiB, with at most one native check per host. A 4-CPU / 12-GiB pool
would not admit these native checks. Both allocations reserve 16 GiB of scratch
per ordinary slot for admission accounting; writable scratch is memory-backed
and charged to the job's memory limit. Scratch is not extra physical RAM.

The trusted daemon has its own user unit capped at 2 CPUs / 2 GiB. Its user
service limits do not bound Docker-created containers: the system slice does.
The outer slice is a ceiling, not permission to increase the admitted job pool.
Raise pools only after measuring host headroom, workload latency and failures.

These vectors fit admission; they do not prove a heavy native project will run
successfully. Count the limited host's native capacity only after representative
native checks pass. A native check needs its whole pool idle, so test fairness
under sustained ordinary traffic too. If native checking is unsuitable, keep
the same outer slice but reduce its node configuration to 4 CPUs / 12 GiB /
two ordinary slots and 32 GiB scratch before admission; its native grant then
cannot fit. Keep the smaller host last in the configured node order when adding
it; this avoids sending the first idle tie to it but is not a priority policy.

## What the administrator provides

Keep installation in the dedicated account's **local** home, for example
`/localhome/leanflow`. Confirm its underlying mount; do not use an NFS home.
Do not change an existing account used for another purpose.

1. A local `leanflow` account, private home, and Docker socket access. Docker
   access is administrative access. No AI agents run in that account; it runs
   only the fixed trusted daemon and reviewed deployment commands. User project
   code runs inside isolated containers.
2. Node 24 or newer at `/opt/node/bin/node`, Python 3, tar, SSH and AppArmor.
   Install a maintained Docker Engine where absent using the
   [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
   Require cgroup v2, the systemd driver, memory/swap enforcement and AppArmor.
   Preserve an existing working Docker installation and its data.
   Verify the exact pinned image ID after import. Fresh Docker 29 installations
   use a [different image store by default](https://docs.docker.com/engine/storage/containerd/);
   a `data-root` setting alone does not move containerd's separate image data.
   Do not switch a shared daemon's backend or migrate its users' images for this
   rollout. Resolve any pin/engine incompatibility before enabling that host.
3. The generated `leanflow-workers.slice` and the pinned kernel-check AppArmor
   profile. Those are the only new system units/policies in this account-based
   installation. Keep the worker application and user service in its home.
4. An agreed local disk and inode policy covering the worker home **and
   container-engine storage**. Each request sets a 64-GiB object budget,
   500,000 objects and a 64-GiB free-space floor on the worker data volume.
   These application controls are not filesystem quotas and do not cover
   another Docker filesystem. Confirm enforced boundaries or explicitly approve
   the shared-engine storage policy. A home quota does not cap `/var/lib/docker`.
5. Append the supplied temporary bootstrap public-key line, preserving existing
   authorized keys, so the operator can finish the reviewed home-directory
   installation. It permits command execution, expires within eight days and
   must be removed immediately after installation. The separate production key
   is forced to the fixed protocol bridge. The administrator retains an approved
   maintenance path for later upgrades.

If the administrator prefers, they can perform the home-directory installation
themselves and omit the bootstrap key. No public worker port is needed; only
SSH from the coordinator. Keep all private keys on the coordinator.

Confirm sshd/firewall/AllowUsers rules admit that key login, a real login shell
is configured, and PAM with `pam_systemd` supplies a user manager. Confirm host
fingerprints through the administrator or the existing trusted connection.
Check directory-service identities and UID conflicts before creating accounts.
Install Docker before adding the user to its group. Leave space for two pinned
images during upgrades on the actual image-store filesystem.

For a new account, the administrator can review these commands:

```sh
getent passwd leanflow
# Only if the account is absent and the chosen local home is approved:
sudo useradd --user-group --create-home --home-dir /localhome/leanflow --shell /bin/bash leanflow
sudo chmod 0700 /localhome/leanflow
sudo usermod -aG docker leanflow
sudo install -d -o leanflow -g leanflow -m 0700 /localhome/leanflow/.ssh

# Run in the reviewed, host-specific request directory:
sha256sum -c SHA256SUMS
sudo install -m 0644 leanflow-workers.slice /etc/systemd/system/leanflow-workers.slice
sudo install -m 0644 leanflow-kernel-check /etc/apparmor.d/leanflow-kernel-check
sudo apparmor_parser -r /etc/apparmor.d/leanflow-kernel-check
sudo systemctl daemon-reload
sudo systemctl enable --now leanflow-workers.slice
```

Append the contents of `bootstrap.authorized_keys` to this account's
`authorized_keys`, owned by `leanflow`, mode 0600. Do not replace the file.
`restrict` disables PTY allocation and forwarding but permits commands unless
a forced command is supplied; the bootstrap line deliberately has no forced
command. It carries a UTC `expiry-time`. See
[OpenSSH key options](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT).

For boot-time availability, the administrator may also approve:

```sh
sudo loginctl enable-linger leanflow
```

[Lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html#enable-linger%20USER%E2%80%A6)
keeps this user's service manager available after logout and starts it at boot.
If it is not approved, use the existing bridge's SSH-session startup policy and
test reconnect, process reconciliation and fresh certification before admission.

## Generate a request

Use a protected copy of the active controller configuration and its exact
execution profile. Use the **already reviewed worker archive matching that
profile**, even when the website runs a newer release. Do not rebuild the worker
from the latest website checkout and silently change its bundle pin.

Generate separate Ed25519 protocol and bootstrap credentials on the coordinator.
Copy only their public keys. Obtain the worker host key through an existing
trusted connection or administrator fingerprint check; do not automatically trust
`ssh-keyscan` output. Set an explicit bootstrap expiry within eight days.

```sh
node scripts/prepare-worker-request.mjs \
  --controller-config /private/controller.snapshot.json \
  --node worker-b --host worker-b.example.org --allocation limited \
  --home /localhome/leanflow \
  --coordinator-key /coordinator/cluster/keys/worker-b \
  --coordinator-known-hosts /coordinator/cluster/pins/worker-b \
  --public-key /private/worker-b-protocol.pub \
  --bootstrap-key /private/worker-b-bootstrap.pub \
  --bootstrap-expires YYYYMMDDHHMMSSZ \
  --host-key /private/worker-b-host.pub \
  --archive /private/reviewed-worker.tar.gz \
  --archive-sha256 INDEPENDENTLY_VERIFIED_ARCHIVE_SHA256 \
  --output /private/new-worker-b-request
```

The command refuses an existing output directory. It checks the archive's
checksum, rejects links and unsafe/undeclared entries, verifies every file and
recomputes the enrolled helper digest without running archive code. The private
output contains the exact source, configuration, user unit, bridge, slice,
AppArmor profile, public-key lines, host pin, disabled controller entry and
checksums. It neither contacts a worker nor changes active configuration.
`controller-entry.json` is a proposed entry, not a whole replacement config.

## Finish installation and activation

Use [the dedicated-account installation](UserExecutionWorkers.md). Before
extracting, compare `SHA256SUMS` with the independently communicated archive hash.
Install the reviewed source in a new private release directory. The supplied
files map to:

| Request file               | Destination                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `worker-source.tar.gz`     | Extract under `~/leanflow/app/releases/BUNDLE_DIGEST`; point `~/leanflow/app/current` there |
| `node.json`                | `~/leanflow/node.json`, mode 0600                                                           |
| `worker-bridge`            | `~/leanflow/bin/worker-bridge`, mode 0700                                                   |
| `leanflow-node.service`    | `~/.config/systemd/user/leanflow-node.service`                                              |
| `protocol.authorized_keys` | Append after the bridge is installed and verified; preserve administrator keys              |
| `known_hosts`              | The coordinator path named by `controller-entry.json`; not the worker account's trust store |

Confirm `getent passwd leanflow` matches the configured home and Node is at the
expected path. Enable the user service through an actual SSH/PAM user session.
Starting it does not enroll the node or make it ready without its pinned image,
toolchains and fresh conformance. Pre-stage large files before any website
maintenance; do not leave the website stopped awaiting an administrator or a
large transfer.

Keep `startUserService: true` and `certifyToolchain` in the supplied node config.
They allow a restarted user manager to start the fixed daemon and run fresh
certification after the managed toolchain is installed. Without lingering,
test a full logout/manager-stop/reconnect cycle. Recheck the daemon's actual
2-CPU / 2-GiB limits and verify `check.kernel` is freshly advertised. Merely
running `sudo -u leanflow systemctl --user` without a user session is insufficient.

The existing maintenance CLI requires mode `off` and exclusive controller-state
ownership. `off` and `shadow` apply to the whole cluster, including the existing
worker; they are not per-node settings. Use this rollout sequence:

1. Back up active configuration and wait for active work to finish. Set cluster
   mode `off` and restart the website only when idle. In this mode the website
   can stay available for local work without owning a cluster controller.
2. Merge the new primary entries **with `enabled: true` while mode is `off`** so
   the offline maintenance CLI can connect. Preserve the existing worker entry,
   lineage and execution profile. Do not replace the full configuration with
   either generated entry or initialize a second live controller.
3. Use the [maintenance CLI](DistributedExecution.md#configure-and-roll-out) to
   install the exact image and managed environments on the new nodes. Run fresh
   host conformance and valid/invalid native and selected-file fixtures. Test
   representative native projects and ordinary/native fairness before counting
   the limited node as native capacity. Compare actual cgroups with each request.
4. Test cancellation, disconnect/reconnect and user-manager restart. A failed
   node stays disabled when restoring service. Recheck the existing worker too;
   losing its last SSH session can restart its user manager.
5. Choose a cluster-wide shadow comparison period on representative projects,
   or restore `serve` only for accepted operations/hosts. Drain work and wait for
   idle before the second website restart. Verify actual placement and the
   existing worker's readiness after reconnection.

Pre-stage bulky files and plan this window before switching modes. The new
workers cannot be certified/enabled through this CLI while the existing live
controller owns the database. Schedule bounded cache maintenance too: a full
store can fail an assigned check, and worker GC requires an idle/off window.

Remove each temporary bootstrap key and verify it no longer authenticates.
Verify the production key accepts only the two protocol names and rejects a
shell command. Retain an administrator maintenance route. No provider key,
coordinator owner token or user credential goes to a worker.

## Prepare for more active editors

Adding check workers alone leaves the four-editor limit unchanged. Increasing
that number to twenty without changing the worker pool and measuring memory
would be unsound: twenty containers at the current 6-GiB limit have 120 GiB of
combined caps, exceeding the coordinator's RAM. Those are caps, not measured
resident memory or twenty dedicated reservations.

The next application milestone is a measured interactive pool, either by
separating local LSP resources from batch resources or by adding a remote LSP
capability. Remote sessions need explicit ownership and leases, bounded framed
stdin/stdout transport, document-version synchronization from the coordinator,
isolated per-session working copies and writable caches, and idle/cancellation/
reconnect cleanup. Canonical source and collaboration stay on the coordinator;
worker-local copies are disposable. Private/unsupported environments need an
explicit local path. These capabilities are planned, not present in this worker
protocol. Any helper/protocol change needs a reviewed pin and fresh certification.

Share each host's CPU/RAM budget across interactive and batch work; do not count
one allocation twice. Keep larapc2 within its small primary allocation when
changing workload mix. Preserve batch and interactive headroom and per-user
fairness rather than treating twenty as a permanent user ceiling.

Measure the coordinator's capture/transfer CPU cost, project-module rebuild
latency and cache pressure as part of this milestone. Remote interactive/batch
priority, native-check starvation protection and safe automatic cache upkeep
are application work to resolve and validate, not additional administrator
packages or already available features.

Acceptance must include twenty real browser accounts with **live Lean diagnostic
responses for every session**, durable distinct edits, a concurrent check burst,
observed worker placement, bounded queue waits and user fairness, plus restart,
disconnect and cancellation tests. Fail on rejected LSP connections or silent
reconnect loops. Record memory, cgroup OOM deltas, CPU pressure, disk/inodes and
request/diagnostic latency. The previous ten-user compilation test did not
establish this. Keep no-inference fixtures unless provider testing is separately
authorized; editor/check capacity does not establish model-serving capacity.
