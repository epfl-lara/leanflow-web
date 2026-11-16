# Distributed editor integration — 16 November 2026

Status: coordinator revision `67657d47d9078401fb58adaa52fa4b8207020b9f` is
deployed and verified. Production remote editors are not enabled. PC06 still
serves the previously accepted check operations; PC05 remains disabled and PC2
is not enrolled.

The implementation adds leased, resource-accounted live Lean sessions, bounded
SSH stream adapters, canonical single-file save mirroring and a real Lean editor
conformance gate. See [operation and rollout instructions](../RemoteEditors.md).
Canonical projects and collaboration remain on the VM.

## Production rollout

The coordinator was restarted after checking that workers, setup and live
connections were idle. Its worker execution profile, capacity settings and user
metadata were preserved. The pinned worker image and previous browser assets
were retained. Both [CI](https://github.com/epfl-lara/leanflow-web/actions/runs/43888718356)
and [security checks](https://github.com/epfl-lara/leanflow-web/actions/runs/43888718479)
passed. Public HTTPS health passed after deployment.

A disposable ordinary account completed a real native kernel check on PC06.
A local Mathlib editor initialized, reported an invalid proof, cleared the error
after correction and saved the corrected canonical source. Both test projects
were permanently removed, the test account was revoked and its plaintext token
was deleted. No model inference was requested. The existing nine-editor admission
setting is unchanged; this smoke check does not accept a higher user capacity.

## Validation receipts

The final Linux suite passed 2,180 tests with two skips and zero failures.
The client typecheck and build passed. Disposable pinned Lean 4.35.0 and Mathlib
4.35.0-rc4 containers passed initialization, invalid/corrected diagnostics and a
Lean read of the mirrored saved source through the remote streaming adapters.
The Mathlib case also passed with the proposed one-CPU editor cap. Their
containers and dependency copies were removed after the tests. Browser
fixtures passed imports, single-file editing, workspace switching and oversized
source handling. These checks do not establish a higher production editor count.
An additional Linux HTTP/WebSocket suite passed all 19 tests, including three
simultaneous authenticated editor sockets routed to two remote adapters and one
local adapter, canonical save mirroring, capacity limits and account isolation.
Its runtime is simulated; it is separate from the real Lean runtime checks.

A separate Linux test passed through the real controller, worker node and
container runtime over loopback framed RPC. It inspected the actual command and
3-GiB / one-CPU caps, verified that no compiler runs after `lake serve`, and
completed LSP shutdown/exit, stdin EOF and confirmed cleanup with exit code zero.
That fixture simulates host enrollment and the outer slice; it does not certify
PC06 or establish networked multi-user capacity.

Claude's initial implementation review found blockers in dependency navigation,
template preloading, editor launch options, account quotas, queueing and cold
captures. Regression fixes are included. Claude's follow-up and guard reviews
found no remaining code blockers and approved committing and deploying the
coordinator with remote placement off. Remote activation remains
separately gated by PC06 installation and acceptance.

Remaining acceptance work includes the reviewed PC06 upgrade,
fresh host certification and multi-user diagnostics with mixed checks on the
installed hosts. The proposed six remote editor slots are an admission policy
inside PC06's existing 24 GiB / 8 CPU pool, not yet a load-test result.

The previous temporary maintenance key and private key were removed after the
November 13 upgrade. The production SSH key deliberately permits protocol
commands only. Installing a new worker bundle needs an administrator-approved
maintenance route or an administrator performing the reviewed home-directory
installation. It does not require more sudo access or running an agent on a PC.

The VM's public Mathlib preset was prepared for reference-based export by
tightening five service-owned permission entries. Public source bytes and
canonical projects were unchanged. Full dependency export and PC06 preload still
need acceptance before enabling editor placement. The reviewed worker bundle is
prepared with digest
`72bb931b89a8eabb6968286f07fd24f5c7017ab3e8085bba7241a107dc75fbc5`;
it has not been installed on PC06.
