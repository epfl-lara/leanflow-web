# Editor availability and transient requests — 16 November 2026

This release separates editor RAM from ordinary build RAM and adds bounded
recovery for transient browser reads. The rollout measurements and final live
settings are recorded below after acceptance.

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
- Preserve the deployed soft-launch, browser-storage and project-setup fixes.

## Investigation

The report concerned Viktor Kuncak on the afternoon of 15 November. No matching
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

These smaller failed profiles must not be used to advertise 25 Mathlib editors.
At 2 GiB each, 25 editors plus one 18-GiB native check would require 68 GiB of
worker budget, exceeding the current VM's permitted budget. Remote check workers
do not yet host language servers. Adding check nodes improves queued build
throughput but does not remove that editor memory boundary.

## Reproduction

Run `scripts/check-editor-load-live.mjs` only with disposable ordinary accounts.
Provide a private mode-0600 fixture token manifest in the format used by
`scripts/lib/compile-load-fixture.mjs`; never use real accounts or an owner token
in the browser. The harness guards and counts assistant POST endpoints, uses
fixture model metadata, and exercises real authentication, files, WebSockets,
Lean diagnostics, saved edits, mixed compilation and account isolation.

```sh
STUDIO_RUN_LIVE_LOAD_TEST=1 \
STUDIO_LOAD_USERS=13 \
STUDIO_LOAD_ORIGIN=https://your-leanflow-host.example \
STUDIO_LOAD_FIXTURE=/private/disposable-accounts.json \
STUDIO_LOAD_OUTPUT=/private/editor-load-results \
node scripts/check-editor-load-live.mjs
```

Create the private output directory with mode 0700 first. The script has no
production URL or token default. Remove its projects, account credentials and
containers after all test jobs stop; retain only token-free result summaries.
