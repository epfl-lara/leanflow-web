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

- `npm test`: **45 passed, 0 failed**. Authentication, origin/ownership checks before worker startup, file/symlink protection, optimistic saves, snapshot integrity and conflict rejection, settings concurrency, proof restrictions, audit failure handling, durable events, process lease recovery, and waiting for in-flight checks before closing SQLite.
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

## Claude Code review

The requested [Claude Code skill](/localhome/milikic/.agents/skills/claude-code/SKILL.md) was actually invoked for architecture, implementation, and follow-up review. The configured model reported `claude-opus-5-5`; effort was not overridden. All three runs completed successfully with no permission denials. Claude had Read/Glob/Grep tools, strict MCP configuration, and no write/test tools. The compiler, browser, and runtime results above were measured separately by this implementation task.

Its useful findings led to isolated Lake evaluation, fresh verification copies, proof-body restrictions, fresh read-only audit home/source, direct pinned-binary audit with project-local source replay, dirty-edit Apply protection, accurate conflict messages, process identity leases, and concurrency fixes. Two earlier claims were withdrawn after checking actual evidence: RCP worked without a duplicated provider table, and Python `str.replace` already replaces every underscore. Review files remain in `/localhome/milikic/.local/state/lemex-web-build/{architecture,implementation,followup}.json`.

## Current scope

Imports support public HTTPS repositories. Private repository credentials, Git push, shared-project ACLs, real-time coediting, thread resumption, and retention/undo UI are future work. Saving source files during an assistant run invalidates the full source baseline; rerun against the new saved project. Conservative proof parsing and executable metaprogramming restrictions may require manual review for advanced Lean syntax.

Hosted LeanExplore currently returns HTTP 403 to larapc2; the UI surfaces this failure. Loogle and local Lean tools work. The bridge network has no domain egress allowlist, and assistant workers can read their provider environment. The release is for trusted collaborators and trusted repositories. Kernel verification establishes Lean acceptance against pinned trusted library imports; formalized mathematical intent still needs human review.
