# Release verification — 2026-10-13

The private larapc2 installation runs from `/localhome/milikic/lemex-web`, derived from lean4web commit `9c4cd4f4ed804b06a24257788894314c93008276`. The user service is enabled with lingering, listens on `127.0.0.1:8090`, and uses independent application state. There is no public hostname configured.

## Native runtime and libraries

Verified upstream Lemex source and native build: `2f0e12c10d0baf7404a83da3b8cb8f04b77822c9`. Remote main matched this commit at the final check. The owned bundle was packaged from the matching installed native `dev-small` build; the executable embeds the full commit and matches the existing Cargo artifact.

- CLI SHA256: `79c41f3ef7805f5bbc5407b8a2f29b1f8caf81c8fb2281d4877bcd64813f3694`.
- Code-mode host SHA256: `4638fb7255e89e98561140e6a188da3b6ef4585fdde778b6c6def2ff20449e6c`.
- Final worker image: `sha256:f6d65d7a7d8eb2a48eae3a596bc085cc02779128cf1051603e84ffc6ea2ceec2`.

The runtime reports provenance read from that exact image rather than a mutable host manifest. The earlier owned bundle is retained in `.runtime/lemex-e77c7045`. Personal Lemex authentication, configuration, sessions, and source builds were not changed by this application.

Lean basics, Mathlib, CSLib, and Physlib all passed real default-import checks without network access and are marked ready. Exact library/toolchain pins are listed in [deployment documentation](LemexWeb.md) and `server/presets.json`. The full Physlib build passed, including its private Lake cache and inherited read-only artifacts.

## Executed checks

- `npm test`: **122 passed, 0 failed**. Authentication, origin/ownership checks before worker startup, file/symlink protection, optimistic saves, snapshot integrity and conflict rejection, settings concurrency, proof restrictions, audit failure handling, durable events, process lease recovery, chat isolation, selected files, recoverable deletion, live mirroring/Undo, reasoning streams, optional deadlines, optimization measurements, and waiting for in-flight work before closing SQLite.
- `npm run check`: TypeScript passed.
- `npm run build`: production client passed. Vite reports a large Monaco/VS Code bundle; HTTP static compression is enabled.
- `node scripts/check-runtime.mjs`: real Lean compilation/kernel replay, fresh read-only audit home/workspace, absent provider credentials in ordinary workers, immutable dependencies, cancellation/timeout child cleanup, concurrent registries, and scoped orphan recovery passed on the final image.
- `node scripts/check-verification.mjs`: project-local imports were rebuilt from source and kernel replayed; a deliberately poisoned cached local olean was ignored, and an imported nonstandard axiom was rejected.
- `node scripts/check-application.mjs`: real Lemex provider invocation, failed-proof diagnostics, repair, independent compilation/kernel replay/axiom audit, explicit acceptance, and a final successful Lean check passed.
- `STUDIO_REVIEW_PROJECT=d84c3097-5abe-4f43-937b-1ae627ac74cd node scripts/check-browser.mjs`: Chromium loaded the editor and received live Lean errors; dirty Apply was disabled, Keep preserved the edits, explicit Discard changed only the local buffer, and reviewed acceptance succeeded. No browser file-save request was sent during review/discard; no browser exceptions occurred. Desktop/mobile/settings screenshots were inspected.

## Real application examples

The final native revision repaired `a + b = b + a` from the incorrect `Nat.add_assoc a b 0` proof to `Nat.add_comm a b`, preserving the statement/imports. Both runs independently reported `compiled=true`, `complete=true`, `kernelChecked=true`, with no axioms or compiler warnings:

| Project | Run | Result |
|---|---|---|
| `670cfe5a-66a6-434b-8c31-83331cc9e827` | `29ea4b75-9524-4877-b443-a7ebb91e4741` | Applied via API; final Lean check passed |
| `d84c3097-5abe-4f43-937b-1ae627ac74cd` | `c594cc0d-39d4-408d-883e-286ecc0aa947` | Reviewed/applied in browser with dirty-edit protection; final Lean check passed |

Public HTTPS Git import was tested against Batteries at `b71aaf60877e673fdb921f06f20987d12ee8a290`, including successful preparation/build and preservation of its Lean 4.35.0-rc4 toolchain. A custom Lean basics workspace at that release also passed creation, branch creation, and explicit commit (`a7bc3ae26bec993fdb7f3721270c428e33fe950c`). Loogle returned 14 matches for `Nat.add_comm`. Cancellation reached a terminal cancelled state, and runtime checks confirmed container-tree removal. Opening nested dependency files kept one `/workspace` LSP connection and successfully loaded read-only library sources.

Machine-local artifacts are retained under `.runtime/`: `release-state.json`, `application-verification.json`, `import-verification.json`, `custom-version-git-verification.json`, `cancellation-verification.json`, `verification-check/result.json`, and `browser/result.json` with screenshots. These contain test evidence rather than login/provider credentials and remain outside Git.

## Optimization compiler checks

The added measurement module passed **9 focused tests** with `node --test server/tests/optimization.test.mjs`, plus JavaScript syntax checks and a clean focused oxlint run. Those tests cover proof-body token conventions, exact UTF-8 wrapper boundaries, conservative unsupported syntax, numeric/marker validation, environment resolution, readonly/no-network worker flags, unsafe paths, and timeout handling. These cases are also included in the 122-test full suite above.

`node scripts/check-optimization.mjs` then ran compiler-only isolated fixtures on the installed Lean basics and Mathlib presets. Each fixture measured `Main.lean` and its local imported `Helper.lean`, replaying source into temporary artifacts. It exercised Unicode namespace/theorem names, a doc comment, a simp attribute, a default binder, and three named theorems. Baseline and candidate compiled; source files remained unchanged by measurement. A deliberately invalid proof of `False` returned `compiled=false` and unavailable metrics.

| Fixture | Toolchain | Proof tokens before → after | Raw heartbeats before → after |
|---|---|---|---|
| Lean basics | `leanprover/lean4:v4.34.1` | 11 → 7 | 38,220 → 38,353 |
| Mathlib (`Mathlib.Data.Nat.Basic`) | `leanprover/lean4:v4.35.0-rc4` | 11 → 7 | 39,336 → 39,416 |

Replacing `simp only [Nat.add_zero]` with `rfl` reduced the fixture's total proof tokens but slightly increased its measured heartbeat cost. The application retains both outcomes and negative reductions. These totals cover the three fixture theorems, not a competition cohort or the complete library. The artifact is `.runtime/optimization-compiler-check.json`; the reproducible script requests no model and gives workers no network access.

Tokens mirror the published convention pinned at `9c98a3a097e53724e35b2a2e7fe316c331efa20a`, verified against `TOKENIZER_SOURCE` in `/localhome/milikic/proof-reduction-competition/src/proof_eval/verification/metrics.py`. The [pinned tokenizer](https://github.com/delta-lab-ai/lean-refactor/blob/9c98a3a097e53724e35b2a2e7fe316c331efa20a/lean_refactor/cc_agent/scripts/proof_utils.py) counts proof bodies and merges its specified operators. Heartbeats adapt the frozen verifier's `IO.getNumHeartbeats` wrapper around synchronous command elaboration with `Elab.async=false` and `maxHeartbeats=0`. The local method ID is `lean-sync-command-heartbeats-v1; arena-proof-body-tokens-9c98a3a`; displayed heartbeats are raw counts divided by 1,000. Baseline/candidate costs use each exact project environment. This does not establish official Arena scores or unchanged proof compatibility across toolchains. No competition dataset, reference cache, experiment artifact, or inference was used.

## Added workbench workflows and verification boundary

The workbench now exposes **Proofs**, **Formalize**, **Optimize**, and **Search** sections. Project chats offer New chat, selection, saved runs, selected context files, and recoverable chat deletion/restoration. New native runs receive bounded, server-owned history only from the selected chat; personal native sessions and other chats are not imported.

Live saved edits are the default for editing tasks, with clean-buffer updates, final independent verification, a diff, and guarded Undo after stopping. Disabling live edits keeps the separate candidate/review-first flow. **Until done** makes the application time cap optional; finite caps and Stop remain available. Reasoning displays only traces or summaries the model/runtime actually emits. Panel resizing, initial/live light/dark goals, and recoverable file/folder/project deletion are implemented as described in [the workbench guide](LemexWeb.md).

`node scripts/check-live-agent.mjs` passed with two real provider turns in project `369cc05a-f3a1-4e71-906b-afb147db3d79`. Repair run `ea9a8071-a35b-4a4a-851f-4457c87bf687` used the unlimited default, exposed 591 characters of reasoning, updated both saved source and the open editor before completion, and passed independent kernel verification. A second Search turn remembered the first turn's task nickname. New chat created a different empty conversation; reopening the first chat and using Undo restored its original proof. The editor retained one Lean connection, with no browser exceptions. Evidence: `.runtime/live-agent/result.json` and screenshots.

`node scripts/check-trash-chats.mjs` passed ten browser checks in its own disposable project. These covered dirty-buffer Cancel, file Undo, folder recovery after reload, project archive/Undo, durable distinct empty chats, chat deletion/Undo, two selected context files, Files before Projects, the four sections, and shared proof defaults. All fixture data was restored; no provider calls, personal deletions, unexpected mutations, or browser/server errors occurred. Evidence: `.runtime/trash-chats/result.json` and screenshots.

A browser check at 1366×768 confirmed the compact starter UI: two suggestions specific to each section and each Proofs task, no welcome block, no empty-conversation overflow, and clicks that keep the selected mode and focus the message box. It made no project mutations or provider requests. Evidence: `.runtime/assistant-start/result.json` and `optimize-compact.png`.

`node scripts/check-layout.mjs` passed against the existing clean proof fixture. Actual goal text had minimum contrast ratios of 5.65 in dark mode and 6.05 in light mode. All four dividers resized and their dimensions persisted after reload. Resizing retained one Lean connection; reloading replaced the worker and initialized one new connection. The fixture hash stayed unchanged, with no API mutations, browser errors, or failed responses. Evidence: `.runtime/layout/result.json` and dark/light/resized/reloaded screenshots.

`node scripts/check-optimization-agent.mjs` made one real Optimize request in its own Lean fixture. Run `b390d9e1-4370-47f5-ac9a-21a7e0a34fa6` reduced proof tokens **17→5** and raw heartbeats **27,139→15,333**. The theorem statement stayed unchanged, saved source and the visible editor contained `exact Nat.add_comm a b`, and independent kernel verification passed with no axioms. Recorded event order places candidate measurement after the successful audit; the browser table displayed the measured values and signed reductions. The request used the configured DeepSeek model, `maxSeconds=null`, and live editing. Evidence: `.runtime/optimization-agent/result.json` and `verified-optimization.png`. Browser assertions were rechecked against the same completed run without another provider request.

## Streaming responsiveness follow-up

The conversation now follows incoming output only while the reader follows its end. Scrolling up pauses following; **Jump to latest** resumes it. Stop stays outside the scroll viewport, and drafts, file navigation, chat selection, and history remain available during a run. Reasoning/activity start collapsed and unmount their bodies when closed. Active text avoids repeated Markdown parsing; completed messages render Markdown. Run options collapse when selecting a task to preserve space on laptop screens.

A run snapshot now includes its durable event cursor. The browser starts SSE after that cursor, batches new events, ignores replayed events and stale snapshots, and prevents a terminal run from becoming active due to a delayed poll. Project run polling omits transcripts; chat polling omits reasoning, logs, and full diffs. Full selected-run snapshots and internal agent conversation context remain available. Stop/Undo/Apply return fresh cursor-bearing snapshots; late responses cannot replace a different selected run. Stop refreshes the editor after any pending live write finishes.

`npm test` passed **122 tests** after four added API regressions covering owned snapshot cursors, replay boundaries, lightweight polling responses, and awaited mutation responses. TypeScript and the production build passed; oxlint completed with warnings and no errors. `node scripts/check-streaming-ui.mjs` passed nine browser checks using mocked API, SSE, and Lean traffic, with no provider calls or real project writes. The fixture starts with about 150 KB of reasoning and 80 KB of activity and sends repeated output bursts. Manual reading stayed at scrollTop 4,050 while conversation content grew from 5,148 to 17,129 px; the page stayed still. At 1366×768 the collapsed options left 216 px for conversation, with Stop and the composer visible. Tests also covered stable detail toggles, editable drafts, blocked concurrent submission, file/history/chat navigation, a delayed Stop after changing chats with a final visible file update, and a stale running poll arriving after completion. No unexpected requests or browser exceptions occurred.

Evidence: `.runtime/streaming-ui/result.json`, `laptop-working.png`, and `working-and-navigable.png`; `.runtime/streaming-tests.log`, `.runtime/streaming-build.log`, and `.runtime/streaming-lint.log`. This is deterministic streaming/UI coverage, not an additional native-provider run. The previously recorded native runtime and proof verification results remain the integration evidence.

## Claude Code review

The requested [Claude Code skill](/localhome/milikic/.agents/skills/claude-code/SKILL.md) was actually invoked for architecture, implementation, and follow-up review. The configured model reported `claude-opus-5-5`; effort was not overridden. All three runs completed successfully with no permission denials. Claude had Read/Glob/Grep tools, strict MCP configuration, and no write/test tools. The compiler, browser, and runtime results above were measured separately by this implementation task.

Its useful findings led to isolated Lake evaluation, fresh verification copies, proof-body restrictions, fresh read-only audit home/source, direct pinned-binary audit with project-local source replay, dirty-edit Apply protection, accurate conflict messages, process identity leases, and concurrency fixes. Two earlier claims were withdrawn after checking actual evidence: RCP worked without a duplicated provider table, and Python `str.replace` already replaces every underscore. Review files remain in `/localhome/milikic/.local/state/lemex-web-build/{architecture,implementation,followup}.json`.

Two additional read-only reviews covered the workbench changes. The UI/live review completed successfully and led to output coalescing, final output flushing, retryable transient mirroring failures, narrower live conflict checks, and recoverable folder-restore reservations. Its artifact is `ui-followup-review.json` in the same review directory.

The final chat/optimization review also completed successfully with no permission denials (session `533389b1-a457-4c57-8ae4-bb26612fb3e8`; configured Opus/medium, with reported Opus 5.5 and Haiku 5.5 usage). Actual Lean 4.34.1 compiler reproductions confirmed three conservative-verifier gaps: ambiguous top-level statement assignments, commands placed after proofs on the same line, and a character literal containing a double quote. Those cases now require manual review or are correctly detected, with four regressions. Review also corrected the terminal measurement status, prevented a new run racing a stopped run's pending live write, kept recently reused older chats in the selector, and clarified that host candidate measurements become available after the native turn. Evidence: `chat-optimization-review.json`; final combined tests are recorded in `.runtime/final-tests.log`.

## Current scope

Imports support public HTTPS repositories. Private repository credentials, Git push, shared-project ACLs, real-time coediting, native thread resumption, and automatic history retention policies are future work. Chats keep bounded server-owned conversation context while each native run starts fresh. Review-first acceptance rejects changes to its saved baseline; live mirroring and Undo check agent-touched files and context without overwriting conflicting saved work. Conservative proof parsing and executable metaprogramming restrictions may require manual review for advanced Lean syntax; optimization metrics explicitly report unsupported syntax as unavailable.

Hosted LeanExplore currently returns HTTP 403 to larapc2; the UI surfaces this failure. Loogle and local Lean tools work. The bridge network has no domain egress allowlist, and assistant workers can read their provider environment. The release is for trusted collaborators and trusted repositories. Kernel verification establishes Lean acceptance against pinned trusted library imports; formalized mathematical intent still needs human review.
