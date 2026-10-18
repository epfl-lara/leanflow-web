# Project checks and Lean caches

Choose **Check Project** after saving your files. LeanFlow uses the project's
pinned Lean release; checking never upgrades its toolchain or dependency pins.

When that release provides `lake check` (including Lean 4.35 release candidates
that ship it), the button builds the default project targets and checks every
declaration in their reachable project modules, including private declarations.
The toolchain's bundled exporter includes each declaration's complete dependency
graph. Native `lake check --from-export` independently replays that export with
Lean's bundled kernel and its unchanged axiom policy.

Only `propext`, `Classical.choice` and `Quot.sound` are allowed. A structural
preflight rejects other exported axioms, including `sorryAx` and unused axioms
declared in project modules, before expensive kernel replay. It inspects the
actual export rather than relying on cached axiom metadata. Imported definitions,
inductives and constructor types retain their full dependency graph.

Unused declarations from imported libraries are outside this project check.
For example, a project using `import Mathlib` checks its own declarations and
every Mathlib declaration they depend on; it does not recheck all of Mathlib's
unrelated declarations. The selected file also receives a compiler check if it
is outside the default targets; independent replay covers the default targets.

Older releases retain `lake build` and selected-file compilation. The output
identifies which check was used. A failed kernel check, missing sandbox or
unavailable worker is reported as a failure; it never triggers a build-only
fallback. **Check File** in a single-file playground retains its compiler check.

Checks run offline, with source and toolchains read only and the project's
private `.lake` build cache writable. If files change during a check, its result
cannot be accepted as a check of the new files: run the check again. Use
**Stop check** to stop its entire worker, including exporter and kernel processes.
Source scans anchor reads to directory handles and do not follow project links;
replaced inputs fail the check. Scans use Python's isolated import mode, as
worker cache registries do, and support cancellation.

## What is cached

- **Project compilation:** Lake retains the project's `.lake` artifacts and
  traces. Unchanged modules can be reused; the independent checker still replays
  the project's complete exported dependency graph on each project check.
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
checking incremental. Exports include all referenced imported declarations and
can take substantial time and memory. The default button uses the standard kernel;
`--paranoid` with all bundled kernels is not enabled by default.

## Docker setup for Lean 4.35 checks

Lake's inner Bubblewrap sandbox needs namespace and mount operations that the
ordinary editor/agent worker profile blocks. Only dedicated project-check
workers use `deploy/lake-check-seccomp.json` and unmasked container system paths.
They retain the non-root UID, dropped capabilities, `no-new-privileges`, private
PID namespace, read-only root/source/toolchains, no network, and resource limits.
Project configuration, builds and export run inside a Bubblewrap sandbox with
the same source/home/network restrictions as Lake's native workflow. An immutable
adapter is mounted read only; it is compiled against the pinned toolchain only.
The project cannot read the outer home or export temporary files. Axiom preflight
loads only the NDJSON export, and native `lake check --from-export` validates it
without importing project `.olean` files into the verdict process. No
`--inadvisably-no-sandbox` flag is used.

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
Reusing compiled packages does not skip replay of the project's referenced
dependency graph. Resource failures are failures, not proof certificates.

An imported local module must belong to a configured Lean library or executable.
Manually cached, unconfigured local `.olean` files fail with a request to add the
module to the Lake targets: Lake would otherwise reuse them without rebuilding
their current source. Local source and build artifacts must remain inside the
project; symlinked artifacts escaping that boundary are rejected. A project with
no local declarations reports that there is nothing to kernel-check.

### Why project declarations are explicit export roots

Lean 4.35.0-rc4's bare `lake check` exports every non-internal declaration loaded
by the default modules. With `import Mathlib`, this includes unused Lake build
implementation declarations referring to generated axioms such as
`Lake.DataType.bool`. Native axiom checking rejects those references even when
the project's mathematics does not use them.

LeanFlow selects roots by actual declaring-module ownership, never by a namespace
or an axiom-name exemption. Its trusted adapter uses the bundled exporter's
explicit-root interface and native `lake check --from-export`. A project
declaration that actually depends on a generated Lake axiom still fails, as do
custom axioms hidden in private declarations, constructors or dependencies.
This scopes the certificate to the project's declarations and their dependencies;
it does not convert a failed native result into success or allow extra axioms.

See [Lean's announcement](https://leodemoura.github.io/blog/2026-10-15-lean-now-ships-with-verified-kernels/)
and [Lake's checker implementation](https://github.com/leanprover/lean4/blob/v4.35.0-rc4/src/lake/Lake/CLI/Check.lean)
for the checker semantics. The [bundled exporter](https://github.com/leanprover/lean4/blob/v4.35.0-rc4/src/LeanExport/Basic.lean)
defines explicit-root dependency traversal; [Lake's native export entry point](https://github.com/leanprover/lean4/blob/v4.35.0-rc4/src/lake/Lake/CLI/Main.lean)
shows the default global-root behavior.
