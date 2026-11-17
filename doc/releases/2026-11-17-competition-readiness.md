# Competition readiness for 25 participants

The deployed release `df68441` passed a same-time start with 25 ordinary accounts, each working in a separate managed Mathlib playground. All 25 editors stayed connected through a round of corrections, durable saves and proof checks. The service advertised 32 qualified editor slots during the rehearsal.

## What participants experienced

| Production measurement                                                       | Result                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| First Lean error after opening the editor                                    | 30.0 s median, 37.6 s at the 95th percentile, 38.6 s maximum |
| Correction, save and exact saved-file readback by Lean                       | 0.736 s median, 0.759 s at the 95th percentile               |
| Mixed proof checks submitted together with all editors open                  | All 13 native checks and 12 Mathlib checks passed in 78.43 s |
| Project list during the run                                                  | 50 probes, 5.1 ms at the 95th percentile, 124 ms maximum     |
| Editor disconnections, failed saves, rate-limit retries, out-of-memory kills | Zero                                                         |

The [protocol harness](../../scripts/check-editor-protocol-load-live.mjs) used the public HTTPS and WebSocket endpoints with real Lean processes and prepared dependencies. All 25 participants began in one batch. Each managed file contained 120 Mathlib arithmetic theorems. The native project contained 400 theorems. Each editor received a genuine error, corrected it, and verified the exact saved source through Lean. The rehearsal also checked that participants could not read each other's files. The [measurement summary](data/2026-11-17-competition-readiness.json) records the results.

A separate mobile Chromium session used production token sign-in, confirmed a display name, reached provider setup, and signed out. Isolated browser tests exercised editor queue promotion and cancellation, phone and tablet layouts, autosave conflicts, streaming, follow-ups and switching accounts. The [earlier 15-browser rehearsal](2026-11-17-primary-workers.md) exercised real Lean through the full browser interface.

## Competition format and limits

- **Individual playgrounds.** Use one managed playground per participant with the prepared public Mathlib environment for the tested capacity. Up to three Lean sessions can run for one account or one project. Opening a fourth tab on the same project can put it on the waiting list.
- **Imported repositories.** Repository language servers run on the coordinator. Its 45 GiB worker budget reserves 18 GiB for batch work. At 6 GiB per repository editor, at most four fit with that reservation, and other interactive work can reduce the number. A 25-person event requiring simultaneous repository diagnostics needs additional qualified capacity. See [remote editor eligibility](../RemoteEditors.md).
- **Assistant use.** Two assistant tasks can run concurrently. Another 32 can wait, with at most four waiting per account. A shared provider key can impose a lower limit. An isolated 25-account submission test admitted two active tasks and 23 waiting with independent provider capacity. The rehearsal made zero inference requests. Provider latency and sustained competition throughput remain unmeasured.
- **Access.** Participants need the EPFL network or VPN. The browser asks each editor to confirm a display name and connect their own provider key. Existing token users can link their EPFL identity from Assistant settings. The live browser check used an invitation token. Signed EPFL callbacks were tested against a simulated identity provider. See [EPFL sign-in](../EPFLSignIn.md).

## Issues fixed

- A synchronized sign-in previously rejected 17 of 25 valid EPFL returns in the simulated-provider test. Cold starts now share discovery. Up to eight code exchanges run while 32 more can wait for up to 45 seconds. All 25 completed with distinct accounts. Account creation, profile changes and command-line account administration now serialize writes across processes.
- Editors falling back to the coordinator could exceed the local editor limit or launch a second fallback. Local reservations now last until cleanup is confirmed. Each Lean message still checks project access, while setup-history reads and dependency inspection run only when project details are requested.
- A background model or template refresh could clear the latest proof-check result. Slow chat polls could stack up, and the elapsed-time counter rerendered the transcript every second. Refreshes preserve check results, polling avoids overlaps, and the timer updates independently of the transcript and its screen-reader announcements.
- Independent verification could fail on a large valid change set because the file and declaration list exceeded the operating system's command argument limit. The verifier now reads changed paths from standard input and obtains declarations from rebuilt Lean modules. A real compiler accepted a correct ordinary proof and rejected an incorrect one. A separate subprocess regression covered a 900-file manifest.
- The Tailwind Vite plugin was installed on the serving host even though only the client build uses it. The runtime install now omits Vite and passed its production dependency audit. The build toolchain still contains picomatch, for which the advisory listed no patched version on the day of deployment. [GitHub advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).

The earlier eight-request limit forced 17 of 25 simultaneous small saves to retry in an isolated test. The production setting now allows 32 small source requests, with at most two per account. The bulk lane keeps its existing two slots. All 25 competition saves passed on the first attempt. This serving profile also increased the assistant waiting limit from 12 to 32.

## Proof feedback and chat

The editor and file outline show a check, warning triangle, error mark or clock beside each theorem, lemma and example that Lean identifies. A check requires Lean to finish reporting diagnostics for the current file version. Editing a proof clears an earlier result. An explicit `sorry` stays visible as a warning even when Lean’s placeholder warning is disabled. Project verification remains available separately.

Mathlib’s `lemma` command can be missing from Lean’s outline. The editor asks Lean for the ranges of those commands, with at most four lookups in flight per editor. A real Lean 4.35 test with 120 Mathlib lemmas made 120 lookups on first open and two after editing the final lemma. Editing the first lemma required checking all 120 ranges again. These measurements used a local compiler.

Chat work steps keep their tool icon and show a text result alongside a distinct status mark. Project diagrams open at actual size inside the conversation. Desktop and phone browser tests covered keyboard disclosure, reduced motion, diagram panning, and focus restoration when closing a figure. The [participant guide](../UsingLeanFlow.md) describes both features.

## Operations and reproduction

The coordinator restarted after two idle checks. All 32 slots were ready in 20.9 seconds. The previous release, its fingerprinted browser assets, and private rollback backups were retained. All three remote workers kept their running processes and certifications. Cleanup removed 50 fixture projects, revoked all 25 rehearsal accounts and the separate browser account, and removed the test credentials.

For another rehearsal, provision disposable accounts and projects using the [load fixture requirements](../../scripts/lib/compile-load-fixture.mjs). Set the existing live-test opt-in, private fixture path, output directory, origin and expected editor capacity. Set both `STUDIO_LOAD_USERS` and `STUDIO_LOAD_EDITOR_ARRIVAL_BATCH` to 25 for a synchronized arrival. The default arrival batch is three. The benchmark prints a summary without credentials. Clean up the fixtures after the sockets and jobs have closed.
