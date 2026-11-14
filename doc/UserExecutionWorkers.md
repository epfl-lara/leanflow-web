# Run a worker in its dedicated account

Use this installation on a shared Linux host after its administrator provides
Docker access, Node.js 24 or newer, Python 3, the bounded container system slice,
and the kernel-check AppArmor profile. Keep all remaining worker files in the
dedicated account's local home. Run the fixed check daemon on the host; project
code runs inside its isolated containers. Do not run an AI agent in this account.

Docker access is administrative access to the machine. Keep its socket, SSH keys
and account home outside every project container. This installation does not use
Docker to change host accounts, mount permissions, system services or policies.

Use [the worker expansion handoff](WorkerExpansion.md) to generate a private
administrator package with a standard or smaller primary allocation, pinned
source and separate temporary bootstrap credentials.

## Install the release and configuration

Verify and extract a [worker bundle](DistributedExecution.md#install-a-reviewed-release)
under `~/leanflow/app/releases/DIGEST`. It needs no npm dependency tree. Point
`~/leanflow/app/current` to that verified release. Use private account-owned
directories and protected regular configuration files.

Store the enrolled node configuration in `~/leanflow/node.json`. Use absolute
local paths for `dataDir` and `socketPath`, such as your real home followed by
`/leanflow/state` and `/leanflow/state/worker.sock`. Configure these optional
fields for this installation:

```json
{
  "startUserService": true,
  "certifyToolchain": "leanprover/lean4:v4.35.0",
  "workerMemory": "6g",
  "workerCpus": 2,
  "memoryBudget": "24g",
  "maxCpus": 8,
  "maxConcurrent": 4,
  "scratchBytes": 68719476736,
  "maxStoreBytes": 68719476736,
  "maxStoreFiles": 500000,
  "reserveBytes": 68719476736
}
```

Merge these fields into the full node configuration; retain its image pin,
controller lineage, node ID and actual parent slice limits. The example gives
jobs 8 CPUs and 24 GiB rather than treating the whole host as dedicated capacity.
The larger system slice is an outer ceiling. Tune admission with the host's
owner and representative measurements.

On a shared filesystem, `reserveBytes` is an application free-space floor.
Object transfers and disposable source/asset copies check that floor. Captured
output and object counts are bounded, and writable check scratch is memory
backed. These controls cannot reserve the volume against unrelated applications;
use a filesystem quota if the administrator requires an enforced account total.
Do not describe the host's currently free space as dedicated worker storage.

## Install the user service and fixed SSH bridge

Copy [the user unit](../deploy/leanflow-node-user.service) to
`~/.config/systemd/user/leanflow-node.service`. Adjust its absolute Node path if
the administrator uses a location other than `/opt/node/bin/node`. The unit
bounds the trusted daemon separately from its Docker-created job containers.

Create `~/leanflow/bin/worker-bridge` with mode 0700:

```sh
#!/bin/sh
set -eu
worker_uid=$(/usr/bin/id -u)
worker_home=$(/usr/bin/getent passwd "$worker_uid" | /usr/bin/cut -d: -f6)
case "$worker_home" in /*) ;; *) exit 64 ;; esac
exec /usr/bin/env -i HOME="$worker_home" PATH=/opt/node/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR="/run/user/$worker_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$worker_uid/bus" \
  SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND-}" \
  /opt/node/bin/node "$worker_home/leanflow/app/current/server/cluster/node.mjs" \
  bridge --config "$worker_home/leanflow/node.json"
```

Enable the service in this account:

```sh
systemctl --user daemon-reload
systemctl --user enable --now leanflow-node.service
systemctl --user status leanflow-node.service
```

Install the coordinator public key with a forced command pointing to the
**absolute** bridge path in this account, with `restrict`. Preserve other
administrator-authorized keys. Do this after installation checks pass so the
production key no longer grants a shell. Private keys stay on the coordinator.
Before restricting the bootstrap key, confirm that the administrator retains a
working maintenance login to this account. An ordinary login to a different
account cannot add keys or switch to this account without permission. Do not use
Docker access or the worker protocol to bypass that separation.

The bridge rejects every command except the two fixed protocol names before
starting anything. For an allowed connection, it starts only the fixed
`leanflow-node.service` user unit and waits for the private socket. It does not
accept unit names, shell commands or container options from the SSH caller.

On a host with normal SSH/PAM user sessions, the persistent controller connection
keeps the user manager available. Without lingering, the service may stop after
the last session ends. On reconnection the bridge starts it again, owned
containers are reconciled, and fresh certification runs before capabilities are
advertised. This avoids requiring a new system unit or a lingering change. Verify
this lifecycle on the actual host before enabling traffic.

## Enroll and check

Use the [maintenance CLI](DistributedExecution.md#configure-and-roll-out) with
distributed traffic off. Transfer the pinned image and toolchain, then run actual
host conformance and valid/invalid proof fixtures. Check restart, cancellation
and connection loss. Keep an operation disabled if it fails containment.

For diagnosis, use `journalctl --user -u leanflow-node.service`. Upgrades need an
approved maintenance login: drain work, stop the service, verify a new release,
switch `current`, restart and certify it. The restricted production key remains
a protocol credential.
