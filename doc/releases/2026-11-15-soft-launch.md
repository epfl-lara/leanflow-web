# Soft-launch readiness review — 15–16 November 2026

For current settings and measured editor resources, see the
[16 November availability rollout](2026-11-16-availability.md). The four-editor
limit below is the earlier deployment snapshot.

Target: about **25 simultaneous users**. Complete the hardware acceptance checks
below before treating that number as supported capacity.

## Changes

- Bound live assistant event connections per account and across the server.
  Closing a connection releases its place. Failed connections retry with backoff
  and use cursor polling after repeated failures.
- Limit waiting assistant tasks per account, including setup repairs. One account
  cannot consume the whole default waiting queue. Running chats retain their
  existing server and provider concurrency limits.
- Defer the Lean editor download until an editor is opened, with visible loading
  and recovery actions. Sign-in and account setup do not need the editor bundle.
- Handle unavailable browser storage during sign-in and onboarding, and report
  invitation failures where the user can act on them. Keep an invitation in the
  address until it can be saved or accepted.
- Wait for a newly selected upload to finish reading before allowing submission,
  so the previous selection cannot be uploaded accidentally.
- Bound queued editor traffic in both directions. A stalled browser or Lean
  worker disconnects with a reconnect action before its queue grows indefinitely.
- Parse fragmented Lean messages with linear buffer growth instead of repeatedly
  copying the whole partial message. In an isolated 8 MiB fixture with 4 KiB
  fragments, one measured run fell from about 1.8 seconds to 24 milliseconds;
  this is not a hardware load-test result.
- Coalesce concurrent file-list requests while a scan is in progress. Saves and
  external changes invalidate it; every caller's access is rechecked after I/O.
  A 25-request fixture shares one scan without retaining stale metadata.
- Queue temporary model-discovery bursts within fixed limits and recover the
  model picker automatically after temporary congestion. Provider/key changes
  invalidate queued results; unavailable permissions still fail closed.
- Distinguish a failed project-list request from an empty account and offer a
  retry, including shared viewers without an API key. Clear old project names
  when signing out. Keep one-use repository credentials when an import fails.
- Point PM2 at authenticated Studio. The unauthenticated legacy entry point now
  requires explicit local-development opt-in and listens only on loopback.

These changes do not provision more execution capacity or change project Lean
versions, selected models, reasoning settings, or provider allowances.

## Capacity observed during review

The reviewed deployment allows seven shared local worker slots, each capped at
6 GiB and two CPUs. Three slots are reserved from interactive work for batch
jobs. The configured editor maximum and effective interactive limit are both
**four connections**. Editors and private terminals share that interactive
allowance. The server permits two active assistants and one private terminal.

Remote execution workers serve pure project checks. They do not add local editor
or assistant capacity. Additional planned workers must pass enrollment,
containment and workload acceptance before their capacity is counted.

With the same 6 GiB worker size and three-slot batch reserve, 25 active editors
require at least **28 effective local slots**. Their worker memory budget is
28 × 6 GiB = **168 GiB**. The existing rule leaving 25% of Docker host RAM outside
that budget requires at least **224 GiB of reported host RAM**. This arithmetic
assumes no extra terminals or assistants beyond the reserved batch allowance.
It is a lower bound for this configuration, not a sizing guarantee. CPU demand,
large project memory, provider limits, disk use and queue latency still need
measurement. Do not raise the current live limits before the hardware is ready.

## Acceptance on the expanded hardware

1. Review every capacity setting in [`.env.example`](../../.env.example), including
   local interactive and batch reservations, queues, worker CPU/RAM, source
   admission, storage reserves and provider allowances. Confirm the effective
   limits reported by `/api/session` after an idle restart.
2. Use 25 disposable ordinary accounts and isolated representative projects.
   Measure cold and warm editor startup, diagnostics, saved-file durability,
   reconnects, and checks while users continue editing. Include simultaneous
   imports and assistant work using a stub provider for interface checks.
3. Record latency, errors, queue waits, CPU, RAM and disk use. Verify account
   isolation, file conflicts, cancellation, and capacity recovery after closing
   editors. Add project and terminal demand to the workload before accepting
   their advertised concurrency.
4. Verify the final HTTPS address, sign-in, streaming and WebSockets from the
   users' network. Keep a consistent private backup and the previous release;
   deploy only after active proof work finishes.

See [verification](../Verification.md), [hosting](../Hosting.md), and
[distributed operations](../DistributedOperations.md) for the existing checks.

## Validation snapshot

Independent Claude Code reviews used Fable 5.2 and Opus 5.5 at maximum effort;
Fable also implemented the browser-storage helpers. Findings were checked against
source and isolated fixtures before being treated as confirmed.

The final application suite passed **2,048 tests**, with one skipped. Type checks,
format checks and the production build passed; lint completed with warnings.
The initial JavaScript entry fell from 9.67 MB to 1.71 MB (about 82% smaller).

All 79 browser suites were exercised, plus the SVG isolation check. Initial
storage and settings recovery failures were fixed and their checks passed after
the final build. One hover-navigation timeout passed an isolated recheck without
a source change; its original timing cause was not established. A trash check
started during a build also passed when rerun against the stable bundle.

Deployment verification includes an idle-work check, a consistent private SQLite
backup, retained browser assets, local and HTTPS health/authentication checks,
and real HTTPS sign-in without opening or modifying user projects. The operator
retains the exact source manifest, check summaries and deployment result.

This review does not certify 25-user hardware capacity. Complete the acceptance
workload above after expansion.
