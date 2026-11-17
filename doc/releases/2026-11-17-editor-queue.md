# Editor waiting list rollout — 17 November 2026

Deployed `27fffa307d6f2c726121a20ec72ece7d95ec78d1` after an idle-work
check. Overflow editor connections now wait with a visible position and connect
automatically. Previously they were rejected at the editor admission limit.
Editing and canonical saves remain available while waiting.

| Machine        | Managed editor slots |
| -------------- | -------------------: |
| Coordinator VM |                    9 |
| larapc05       |                    9 |
| larapc06       |                    9 |
| larapc2        |                    5 |
| Total          |                   32 |

The live waiting room holds 128 connections, at most three per account, for up
to one hour. Active limits remain three per account and three per project.
These are separate limits. Large repository editors still use the coordinator
and their existing larger allocation. Read [the operating behavior and settings](../RemoteEditors.md#waiting-for-an-editor).

This was a coordinator and browser release. All three worker processes kept
their epochs, certified bundle, images, resource policies and warmed Lean
assets. Canonical projects and authentication remain on the VM. The prior VM
release remains available for rollback.

## Verification

- On the VM: 2,301 application tests passed, two existing tests skipped, zero
  failures. Type checking, lint and the production client build passed. Lint
  retains existing warnings.
- The admission model exercised 36 connections against 32 slots. Separate
  regressions covered a logical limit of four with only one real worker free,
  retrying when both waiting limits are full, cleanup retry, and a failed start
  whose cleanup remains pending while a healthy editor starts.
- The built browser passed queue display before LSP initialization, typing and
  saving while waiting, position updates, promotion on the same socket with
  current text, disabled restart while waiting, and cancellation on project
  switch. Startup failure, idle sleep and workspace-switch suites also passed.
  The deployed browser assets match those checked before the final server-only
  fault-isolation change.
- Live acceptance used an ordinary account and actual Lean. Three Mathlib
  editors ran across PC05, PC06 and PC2; a fourth waited without creating a
  remote attempt. Its canonical save survived waiting. Closing one fixture
  editor promoted that same socket; Lean accepted the corrected proof and read
  the saved source. Other sessions stayed connected. Cancelling another waiter
  created no remote attempt. Native proof checks passed locally and on PC06.
- The live test used three running editors and one waiter to exercise the
  account limit. It was not a new 33-user hardware load test. The 32-slot global
  overflow case was tested in the admission model.
- End to end, closing the fixture editor through promotion, Mathlib diagnostics
  and the saved-file read took **26.466 seconds**. This includes confirmed worker
  cleanup and Lean startup; it is not a measurement of queue bookkeeping alone.
  Startup reservations are serialized in this rollout; running editors execute
  in parallel. Slow startup can delay new admissions. SSH creation is immediate
  and the hello RPC has a 15-second timeout; worker preparation has its existing
  deadlines. No live worker was deliberately broken for this acceptance test.
- Claude Code, using Claude Opus 5.5 at maximum effort, reviewed the change.
  Reported startup and cleanup faults were corrected and covered by regressions.
  The final review found no confirmed rollout blocker. It ran no tests itself.
- Public HTTPS returned 200 and served the exact deployed index. After fixture
  cleanup, admission reported zero active and zero waiting connections, with
  all 32 managed slots ready. All three worker epochs were unchanged.

## CI limitation and cleanup

[CI application checks](https://github.com/epfl-lara/leanflow-web/actions/runs/44148994058)
passed before the dependency audit failed on the existing `picomatch` advisory
`GHSA-fc5q-39xc-vjpf` through Vite/tinyglobby. Package manifests and the lockfile
were unchanged. This prevented the full CI browser stage from running; the four
browser suites above ran separately on the VM.
The [Security workflow](https://github.com/epfl-lara/leanflow-web/actions/runs/44148993846)
passed. This does not assert that all existing dependency or CodeQL findings are
resolved.

All six disposable projects and the test account were removed. Maintenance SSH
carriers were stopped. The unused candidate and duplicate test/build tree were
removed, recovering about 1.31 GiB; about 81.2 GiB was free afterward. Production
data, caches, pinned assets and required rollback releases were preserved.

The machine-readable [receipt](data/2026-11-17-editor-queue.json) records the
limits, test scope, worker epochs and live acceptance result without credentials.
