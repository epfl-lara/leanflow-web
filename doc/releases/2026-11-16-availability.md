# Editor availability and transient requests — 16 November 2026

This release separates editor RAM from ordinary build RAM and adds bounded
recovery for transient browser reads. The accepted deployment increases the
managed single-file editor maximum from four to nine. A separate 25-account
compilation burst passed with queueing.

## Changes

- Give the fixed Lean language-server command in managed single-file projects
  optional editor CPU/RAM caps. Repository editors retain their existing size.
  Keep total RAM accounting, protected compiler capacity, class reservations,
  ordinary container isolation and the 25% host-memory headroom rule.
- Limit editor connections per account across projects. Closing a connection
  releases its place without closing another account's editor.
- Retry GET/HEAD requests at most twice after a browser network failure or HTTP
  429/502/503/504, including interruptions while reading a response body. Use
  jittered backoff and respect Retry-After up to three seconds; return longer
  waits to the caller. Stop on cancellation or an explicit account change.
- Never replay writes or assistant actions automatically. An interrupted write
  reports that its outcome is unknown, so the interface does not claim it saved.
- Preserve the deployed soft-launch, browser-storage, project-setup and Git
  integration fixes, including the update installed during this rollout.

## Investigation

The reported incident occurred on the afternoon of 15 November. No matching
service restart or error appeared in the accessible service journal during that
window. The reverse proxy's request/error logs are administrator-readable, so
those could not be correlated. The exact original request and cause remain
unconfirmed. A browser fetch failure does not establish an SSH problem.

Loopback health and project-list probes returned about 1–12 ms without failures.
The first session reads took about 0.4 seconds during model metadata loading;
subsequent reads were about 9–10 ms. Provider discovery remains account scoped
and fails closed on key/provider changes or failed refreshes.

Real Chromium fixtures recover automatically after a connection reset and HTTP 429. A persistent unavailable project list still shows an actionable error and
manual retry; it is never shown as an empty account. No inference was requested.

## Resource measurements

A real isolated Mathlib language server imported Mathlib and checked 120
`norm_num` theorems. The test then introduced an in-memory false proof, waited
for Lean error diagnostics, corrected it, waited for clear diagnostics and
requested a hover. These were disposable account projects, with network off,
read-only root/source, no swap and the production pinned image/toolchain.

- 1280 MiB / 0.2 CPU: OOM kill; failed acceptance.
- 1536 MiB / 2 CPUs: OOM kill; failed acceptance.
- 2 GiB / 1 CPU: passed real diagnostics and hover. First error diagnostics took
  42.4 seconds; correction completed about 0.21 seconds later. The memory peak
  reached the 2-GiB cap with no OOM kill. Loopback health p95 was 4 ms, max 6 ms.
- 2 GiB / 2 CPUs: passed the same checks in 21.3 seconds, with error diagnostics
  at 21.1 seconds and correction about 0.21 seconds later. No OOM kill; loopback
  health p95 and max were below 4 ms. This is the selected editor CPU limit.

The subsequent 13-editor / 2-GiB stress test failed: concurrent edits and
compilation caused eight cgroup OOM kills. All 13 check jobs still completed;
that did not make editor behavior acceptable. That configuration was replaced.

## Accepted live configuration and load tests

The accepted single-file editor allocation is **3 GiB / 2 CPUs**, with at most
**nine** simultaneous language-server connections. Repository editors retain
**6 GiB / 2 CPUs**. A mix containing repository editors therefore permits fewer
connections. Per-account and per-project maxima are both three.

The local runtime has 12 total slots, a 128-place worker queue, a 45-GiB shared
memory budget, one protected interactive slot and three protected batch slots.
The batch RAM reserve is 18 GiB. Nine small editors reserve 27 GiB, leaving a full
18-GiB native check within the same budget. Ordinary workers retain 6 GiB / two
CPUs; assistant, terminal and provider limits were preserved.

The capacity values applied to the private service environment are:

```dotenv
STUDIO_MAX_WORKERS=12
STUDIO_MAX_WORKER_QUEUE=128
STUDIO_MAX_EDITORS=9
STUDIO_MAX_EDITORS_PER_USER=3
STUDIO_MAX_EDITORS_PER_PROJECT=3
STUDIO_RESERVED_INTERACTIVE_WORKERS=1
STUDIO_RESERVED_BATCH_WORKERS=3
STUDIO_WORKER_MEMORY=6g
STUDIO_WORKER_CPUS=2
STUDIO_WORKER_MEMORY_BUDGET=45g
STUDIO_EDITOR_MEMORY=3g
STUDIO_EDITOR_CPUS=2
STUDIO_RESERVED_BATCH_MEMORY=18g
```

These values are a measured profile for this VM, not defaults for every host.

The accepted HTTPS browser test used nine distinct ordinary accounts and real
Mathlib language servers concurrently. Every account introduced an erroneous
proof, received Lean error diagnostics, corrected it, received clear diagnostics
and durably saved its own source. All nine mixed checks completed while the
editors remained open. There were **zero browser errors and zero OOM kills**.
The check burst finished in 53.5 seconds. Cgroup monitoring observed a 2.38-GiB
peak for one editor and a 19.64-GiB peak aggregate editor charge.

Browser project-list probes during full-file edits and checks had a 21-ms median,
1.24-second p95 and 1.44-second maximum. This remains a heavy CPU workload;
proof diagnostics are not instantaneous. The test does not establish latency
for arbitrary projects, sustained inference or a cold operating-system cache.

A separate **25-account mixed compilation burst passed all 25 checks** in
60.9 seconds: 13 native checks ran on larapc06 and 12 Mathlib checks ran locally.
Submissions arrived within 128 ms. Peak execution was six local batch slots and
one remote native check, with queueing; this was not 25 simultaneous processes.
Loopback session probes had a 6-ms median, 11-ms p95 and 138-ms maximum while
remote execution was active. Foreign project files and check jobs remained
inaccessible. The harness requested no inference.

An additional live admission check confirmed the three-connection account limit
across projects, a busy response for the tenth small editor, repository editors
retaining 6 GiB, and a native check still admissible with nine small editors open.
All test editor connections were released afterward.

The [token-free measurement summary](data/2026-11-16-availability.json) records
these results and the rejected configurations. The benchmark uses constructed
files with 400 elementary native theorems or 120 Mathlib arithmetic theorems;
it is not a recorded user research workload.

## Further expansion

Twenty-five active Mathlib editors at the accepted 3-GiB size, plus one 18-GiB
native check, would require 93 GiB of worker budget. The current VM permits only
45 GiB. Adding check workers improves build throughput but does not move Lean
language servers off this VM. larapc05 remains disabled; larapc2 is not enrolled.
Their readiness must not be counted as active editor capacity.

The next step is the reviewed remote-language-server work described in
[worker expansion](../WorkerExpansion.md#prepare-for-more-active-editors):
leased sessions, bounded framed transport, document-version synchronization,
disposable isolated working copies and caches, and reconnect/cancellation
cleanup. Canonical storage stays on the coordinator. This implementation remains
open; enrolling check workers alone does not complete the 25-editor launch gate.

## Reproduction

Run `scripts/check-editor-load-live.mjs` only with disposable ordinary accounts.
Provide a private mode-0600 fixture token manifest in the format used by
`scripts/lib/compile-load-fixture.mjs`; never use real accounts or an owner token
in the browser. The harness guards and counts assistant POST endpoints, uses
fixture model metadata, and exercises real authentication, files, WebSockets,
Lean diagnostics, saved edits, mixed compilation and account isolation.

```sh
STUDIO_RUN_LIVE_LOAD_TEST=1 \
STUDIO_LOAD_USERS=9 \
STUDIO_LOAD_ORIGIN=https://your-leanflow-host.example \
STUDIO_LOAD_FIXTURE=/private/disposable-accounts.json \
STUDIO_LOAD_OUTPUT=/private/editor-load-results \
node scripts/check-editor-load-live.mjs
```

Create the private output directory with mode 0700 first. The script has no
production URL or token default. Remove its projects, account credentials and
containers after all test jobs stop; retain only token-free result summaries.
For the separate API compilation burst, use `STUDIO_LOAD_USERS=25` and
`STUDIO_LOAD_ROUNDS=mixed` with `scripts/check-multi-user-compile-live.mjs`.
The [ten-account test guide](2026-11-13-ten-user-compilation.md) describes its
remaining loopback-only coordinator, private manifest and enrolled-worker settings.

## Verification

The integrated Linux application suite passed 2,153 tests, with two skipped.
Type checking and the production client build passed; lint completed with
existing warnings. Real Chromium recovery fixtures cover connection resets,
short Retry-After, persistent project-list failures and explicit retry.

Claude Code (Opus 5.5, maximum review effort) independently reviewed admission
and browser retry safety. Its reservation-clamping and terminal-RAM findings
were fixed and covered by regressions. The originally proposed 12-GiB reserve
was replaced by an 18-GiB reserve. Follow-up tests exercise the actual API wiring,
write non-replay, interrupted bodies, account revisits and unacknowledged saves.
Seven browser recovery checks passed after their injected failures were made
persistent throughout automatic retries and their Git/profile expectations were
aligned with the current UI. Draft, privacy, confirmation and non-replay checks
were retained. Claude implemented those bounded test changes; the parent ran
the actual Chromium checks.

The previous release and consistent private SQLite/configuration backups were
retained. The idle deployment became healthy in about three seconds; the later
resource adjustment took about five seconds. The remote worker configuration,
execution profile, image and certification were unchanged. Cleanup uses the
application trash/purge APIs and revokes only the disposable test accounts.
