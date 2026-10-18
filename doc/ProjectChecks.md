# Project checks and Lean caches

Choose **Check Project** after saving your files. LeanFlow uses the project's
pinned Lean release; checking never upgrades its toolchain or dependency pins.

When that release provides `lake check` (including Lean 4.35 release candidates
that ship it), the button builds the default project targets, exports them and
independently rechecks them with Lean's bundled kernel. It rejects uses of
nonstandard axioms, including `sorryAx`. It also compiles the selected file if
it is outside the default targets. That additional file check is compiler
validation; independent kernel replay covers the default targets.

Older releases retain `lake build` and selected-file compilation. The output
identifies which check was used. A failed kernel check, missing sandbox or
unavailable worker is reported as a failure; it never triggers a build-only
fallback. **Check File** in a single-file playground retains its compiler check.

Checks run offline, with source and toolchains read only and the project's
private `.lake` build cache writable. If files change during a check, its result
cannot be accepted as a check of the new files: run the check again. Use
**Stop check** to stop its entire worker, including exporter and kernel processes.

## What is cached

- **Project compilation:** Lake retains the project's `.lake` artifacts and
  traces. Unchanged modules can be reused; the independent checker still replays
  the exported environment on each full project check.
- **Dependencies:** prepared presets and immutable shared dependency stores keep
  compiled packages separate from project source. Reuse is scoped by exact
  dependency configuration, pinned Lean release, worker image and, for imported
  environments, account. Shared packages are mounted read only. These remain
  build-environment certificates, not proof-verification certificates.
- **Checker support:** a bounded in-memory cache records the capabilities of an
  exact Lake installation. Replacing its binary, changing the project toolchain
  or changing the worker image causes a new probe. Failures are not cached as
  lack of support.
- **Editor state:** a bounded recent-file worker cache keeps Lean responsive.
  Source/import changes invalidate it; it is separate from project checking.
- **Verification homes:** disposable worker homes are removed after confirmed
  worker teardown, including failed checks. Persistent project homes are retained.

The new kernels improve independent checking. They do not make external kernel
checking incremental. Full exports include imported declarations and can take
substantial time and memory. The default button uses the standard kernel;
`--paranoid` with all bundled kernels is not enabled by default.

## Docker setup for Lean 4.35 checks

Lake's inner Bubblewrap sandbox needs namespace and mount operations that the
ordinary editor/agent worker profile blocks. Only dedicated `lake check`
workers use `deploy/lake-check-seccomp.json` and unmasked container system paths.
They retain the non-root UID, dropped capabilities, `no-new-privileges`, private
PID namespace, read-only root/source/toolchains, no network, and resource limits.
Lake's own sandbox stays enabled; no `--inadvisably-no-sandbox` flag is used.

One full check runs at a time. It reserves up to three worker slots and their
combined RAM/CPU allowance; other jobs can use the remaining slots. Exports use
disposable disk storage rather than the ordinary worker's small RAM filesystem.
To keep full checks available while every editor is connected, provision at
least `STUDIO_MAX_EDITORS + 3` worker slots and budget their memory allowance
plus headroom for the server and operating system. Otherwise full checks queue
until an editor or another worker releases enough slots.
The export file is capped at 8 GiB by default, with free-space admission before
launch, and removed after confirmed worker teardown. Adjust
`STUDIO_KERNEL_EXPORT_MAX_BYTES` only with sufficient free space. The filesystem
must have that amount free plus 512 MiB before a check starts.

On an AppArmor-enabled Linux Docker host, install the dedicated profile once:

```sh
sudo install -m 644 deploy/leanflow-kernel-check.apparmor \
  /etc/apparmor.d/leanflow-kernel-check
sudo apparmor_parser -r /etc/apparmor.d/leanflow-kernel-check
```

The profile is loaded again by AppArmor at boot. Hosts without AppArmor do not
need this step. The seccomp and AppArmor profiles are adapted from
[Moby profiles 4b8214f](https://github.com/moby/profiles/tree/4b8214fc4971e06172938a1f1554ccff6647ee80),
with namespace operations permitted for this dedicated worker. No privileged
container, host PID/network namespace or Docker socket is provided.

## Storage and compatibility limits

The existing shared-cache key deliberately includes the worker image. An image
change can require revalidation even when only Lemex changed. Relaxing that key
would need a separately versioned Lean build-environment identity.

Shared stores and toolchains currently have no automatic size-based eviction.
Review free disk and references before removing entries; never delete a cache
that a project, snapshot or worker still uses. The worker's memory, temporary
filesystem and time limits also apply to exports and kernel replay. A large
imported library may need larger limits than a small standalone proof.
In particular, `import Mathlib` exports all of Mathlib on every full check.
Focused imports reduce that work. Reusing compiled packages does not skip their
independent kernel replay. Resource failures are failures, not proof certificates.

See [Lean's announcement](https://leodemoura.github.io/blog/2026-10-15-lean-now-ships-with-verified-kernels/)
and [Lake's checker implementation](https://github.com/leanprover/lean4/blob/v4.35.0/src/lake/Lake/CLI/Check.lean)
for the checker and export semantics.
