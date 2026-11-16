# Project setup readiness — 16 November 2026

Project setup now handles more pinned Lean environments and offers assistant
help before the environment is ready. Users can ask for help directly from a
failed setup without copying logs or losing their draft, model, or reasoning
effort. See [using setup help](../UsingLeanFlow.md#open-a-project).

## Changes

- Support older and newer Lake dependency descriptions and import-check output.
  Source folders containing spaces and modules outside the default build targets
  are included in setup checks.
- Rebuild private dependency caches after a failed setup while keeping project
  sources read-only. Failed partial caches are excluded from assistant and
  independent verification copies.
- Save automatic configuration repairs as a recoverable transaction. Concurrent
  edits stop acceptance, and interrupted transactions preserve the original
  configuration or finish recovery before further writes.
- Offer **Ask Lemex to fix setup** for missing and failed environments. Diagnostics
  go to the assistant as reference data. The user reviews configuration changes
  before applying them and retrying setup.
- Enforce the setup-help scope at execution and acceptance: only the four root
  Lean/Lake configuration files can change; existing Lean releases, dependency
  sources, revisions, and proof sources are preserved. Users can explicitly exit
  setup help for broader project work.
- Keep conversations and drafts available during preparation. Ordinary notes
  edits do not require a working Lean environment.

## Validation

- Full test suite: 2,090 passed, one skipped, no failures.
- Type checking, formatting, lint, and client build passed. Lint retains warnings.
- Seven browser suites passed, covering setup help, import environment choices,
  model options, chat, chat recovery, provider settings, and settings recovery.
- Real workers passed six layouts: TOML and executable Lean Lake files on Lean
  4.13.0, 4.19.0, and 4.35.0. Each used a source folder containing spaces,
  nondefault modules, and an in-project local dependency. Builds, editor goals,
  hover, and interactive goals worked without changing pins or source bytes.
- A cold-cache recovery fixture failed with the previous read-only cache policy
  and built with the new private cache policy. Direct proof-source writes were
  rejected. No model requests were used for these checks.
- Claude Opus 5.5 at maximum effort reviewed setup behavior and safety; confirmed
  findings were checked against source and regression fixtures.

Repeat the compatibility checks with the commands in
[Verification](../Verification.md).

## Supported boundaries

These checks establish the tested layouts, not compatibility with every Lean
release or repository. A selected project folder must contain its local path
dependencies. Recognized references outside that folder stop with an actionable
message before automatic repair; parent directories are not mounted implicitly.

Repositories with several independent Lean roots still require choosing the
project subdirectory during import. A pin inherited only from an ancestor folder
is not automatically imported. Setup help cannot repair mathematical source
errors within its configuration-only scope; use an ordinary chat for requested
source changes.

This work does not establish capacity for 25 simultaneous users. Validate that
separately on the expanded hardware as described in the
[soft-launch capacity report](2026-11-15-soft-launch.md#acceptance-on-the-expanded-hardware).
