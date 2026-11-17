# Distributed Lean editors — accepted 17 November 2026

**PC06 now serves managed single-file Lean editors and checks.** The live
15-account acceptance passed with six editors on `larapc06.epfl.ch` and nine on
`icvm0135.xaas.epfl.ch`. Remote placement is enabled. PC05 remains disabled
pending administrator preparation; PC2 is not enrolled.

The VM runs revision `7dfb78aec33f54f1ce1483e30c069b020cbdb0b8`. PC06 runs worker bundle
`cc7080df981d0ddb00c30c0d8b511b53e4c245c4b82a96b76843b2753a70ddb2` with the unchanged pinned execution image
`sha256:0ef38c7e4ec01c43f82152aee50557730180111413a51dd01418aaf741c2a85d`. See the
[operation and eligibility guide](../RemoteEditors.md) and
[machine-readable receipt](data/2026-11-16-remote-editors.json).

## Measured serving behavior

| Check                                                                             | Result                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Concurrent authenticated managed Mathlib editors                                  | 15: nine VM, six PC06                                          |
| Invalid-proof diagnostics, corrections and distinct durable saves                 | Passed for all 15                                              |
| Mixed checks with every editor held open                                          | 15 completed: eight native kernel checks, seven Mathlib builds |
| Native fallback while PC06 editors occupied its pool                              | Observed on the VM                                             |
| Compile burst completion                                                          | 110.6 seconds                                                  |
| HTTP probes                                                                       | 181; median 10.1 ms, p95 245.9 ms                              |
| Slowest HTTP probe                                                                | 13.94 seconds                                                  |
| Unexpected editor disconnections, late diagnostic errors, reported request errors | Zero                                                           |
| Worker OOMs, cleanup holds, inference requests from the tests                     | Zero                                                           |

The workload used 120 distinct arithmetic theorems per Mathlib editor and 400
associativity theorems per native compilation project. These results cover this
managed single-file workload. Arbitrary repository editors have different
resource requirements. Twenty-user acceptance awaits more enrolled workers.

The accepted browser run executed on the VM in the official Playwright image,
with an **8 GiB / two-CPU** container limit. Its measured peak was
7.144 GiB, with no OOM or memory-limit events.
The generator shared the coordinator, so its resource consumption is part of the
measurement. The 13.94-second probe outlier is retained in the receipt; the
result is a capacity test, not a latency guarantee. A preceding laptop-hosted
attempt exhausted client resources and is excluded from capacity claims. No
browser load generators remain on the laptop.

## Readiness and restart

Installing dependency bytes alone does not qualify a Mathlib editor. The worker
compiles fixed public source, then verifies invalid and corrected diagnostics
and a Lean read of the mirrored saved file with the actual 3 GiB / one-CPU editor
profile. It advertises the exact toolchain, dependency and public-configuration
tuple only after cleanup. Qualification is earned again for every worker epoch.

The recorded restart requalified in 61.85 seconds. Its compiler phase took
6.13 seconds and its LSP conformance phase took
25.74 seconds. During that full-node maintenance window, the website
continued local serving. No system slice, AppArmor profile or user privilege was
expanded.

A fresh ordinary-account editor passed after the mixed burst. Another passed
after 315.96 seconds without test workers. Both checked an invalid proof,
accepted its correction and read the canonical saved content through Lean on
PC06. The explicit error diagnostic arrived within
53.80 seconds after load and
34.73 seconds after idle, including the preceding native-check
smoke and project setup. Both were below the 90-second acceptance bound.

PC06 retains its agreed 24 GiB / eight-CPU pool: six editor slots at 3 GiB /
one CPU leave 6 GiB / two CPUs for an ordinary compatible check. The coordinator
retains its 18 GiB native-check reserve. The test observed at most 18 GiB /
six CPUs granted to PC06 and 45 GiB on the VM. Admission caps describe reservations;
they are separate from physical memory measurements and user throughput.

## Review, checks and cleanup

Claude Opus 5.5 reviewed the implementation at maximum effort. Its restart-path
findings were fixed and independently rechecked: a failed source copy no longer
unnecessarily quarantines ordinary checks, database invalidation cannot leave
maintenance set, abandoned warm-ups and bindings are removed, and unconfirmed
container cleanup blocks further work. Legacy and versioned public presets use
the same verified resolver.

[CI](https://github.com/epfl-lara/leanflow-web/actions/runs/43956277842) and
[security checks](https://github.com/epfl-lara/leanflow-web/actions/runs/43956277807) passed. CI passed on Node 24 and 26;
the Node 24 application suite recorded 2,194 passes, one skip and zero failures,
plus seven reporting-helper tests. Focused worker/controller checks passed 64
cases and the final preset regression checks passed 27.

All 30 load-test projects were permanently purged, all 15 test accounts revoked,
and their plaintext credential files removed. Each two-project fresh-session
smoke also purged its projects, revoked its account and removed its token.
Final checks found no active/held attempts, warm-up copies or warm-up registry
entries. The production SSH key still rejects shell commands. The separate,
explicitly approved long-term maintenance key remains installed; temporary
maintenance carrier sessions were stopped. No AI agent ran on a LARA PC.

Canonical projects, authentication, SQLite and collaboration remain on the VM.
Public toolchains, dependency caches and disposable execution copies use PC06's
local disk. General project storage on the PCs remains deferred.
