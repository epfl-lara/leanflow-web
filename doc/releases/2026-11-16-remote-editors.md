# Distributed editor integration — 16 November 2026

Status: the coordinator at `67657d47d9078401fb58adaa52fa4b8207020b9f`
continues serving with remote editors off. PC06 has the reviewed
`72bb931b89a8eabb6968286f07fd24f5c7017ab3e8085bba7241a107dc75fbc5`
worker installed, its native check capabilities certified, and the exact public
Mathlib environment preloaded. PC05 remains disabled; PC2 is not enrolled.
The cold-start qualification gate is awaiting its reviewed deployment and live
acceptance. This record will be updated with the actual result.

Canonical project files, accounts, collaboration and durable saves stay on the
VM. The PCs hold public dependencies and disposable execution copies. See
[operations and eligibility](../RemoteEditors.md).

## Installed PC06 resources

The worker shares its existing 24 GiB / eight-CPU pool between checks and editors.
The candidate policy admits six managed Mathlib editors at 3 GiB / one CPU each,
leaving 6 GiB / two CPUs for an ordinary check. Native checks require 18 GiB /
six CPUs and use the VM when the PC cannot fit them beside persistent editors.
The VM retains its 18 GiB native-check reserve and nine-editor local ceiling.
No system slice, AppArmor policy or user privilege was expanded.

The administrator restored separate maintenance access on PC06. The explicitly
approved long-term maintenance key is retained; the production key remains
protocol-only and rejects shell commands. No AI agent runs on a LARA PC.

## Cold-start correction

A first cold Mathlib editor initialized but did not produce the requested error
diagnostic within 240 seconds. A compiler warm-up followed by the same 3 GiB /
one-CPU language server passed invalid/corrected diagnostics and a Lean read of
the mirrored saved source. A subsequent ordinary-account WebSocket smoke test
also passed and cleaned its projects and account. An actual editor OOM was not
established; certification deliberately exercises the container memory boundary.

Dependency bytes alone therefore no longer qualify a Mathlib editor environment.
The new gate first compiles its fixed public source with the ordinary check
allocation, then runs the actual editor profile through diagnostics, correction
and saved-file reading. It advertises only the exact toolchain, dependency and
public-configuration tuple, after cleanup. Every worker restart must earn fresh
qualification. The entire PC06 node is in maintenance during that process;
ordinary checks use other capacity until it finishes.

Claude's implementation review found two restart-path blockers: missing-root
cleanup could unnecessarily quarantine ordinary checks, and failed database
invalidation could leave maintenance set. Both have regression fixes. Additional
changes clean abandoned warm-ups and bindings, stop after unconfirmed cleanup,
report qualification failures and require the exact environment in CLI success.
Claude verified the corrections and cleared installation with placement off,
followed by a temporary live acceptance window after qualification and restart
checks. The final preset-root guard reuses the shared verified resolver for
both legacy and versioned template directories.

## Validation and remaining acceptance

The corrected Linux suite passed 2,192 tests with two skips and zero failures.
The 64 focused worker/controller tests passed, including real-runtime cleanup
for existing and already-removed roots, live-child refusal, failed database
invalidation, restart qualification failure and ordinary-check continuity.
Client type checking and scoped formatting pass. Lint exits successfully; the
warm-up cleanup deliberately overrides earlier failures when cleanup is unsafe.

The previously deployed production smoke passed a native check on PC06 and a
real remote Mathlib editor, with canonical saved-file mirroring and cleanup.
That single-session result does not establish higher multi-user capacity.

Remaining work: install the final reviewed cold-start bundle with placement off,
qualify the exact environment, measure one worker restart, then temporarily enable
placement for a 15-account browser acceptance test. Require six actual PC06 plus
nine local editors, live diagnostics and distinct saves for every account, mixed
checks, isolation, no OOMs or cleanup holds, and fresh remote diagnostics within
90 seconds after mixed load and an idle interval. Keep placement enabled only
if acceptance passes. Twenty-user acceptance still needs additional enrolled
workers; no twenty-user capacity claim is made.
