# Verify before sharing

Run these checks after installation and after upgrading the app or worker. Use a disposable project and a separate browser profile; keep existing projects and credentials private.

## Check the shared address

1. Open the final HTTPS address from the network your collaborators will use. Confirm a trusted certificate and an HTTP-to-HTTPS redirect. A private address can require an institutional VPN even when TLS works.
2. Sign in with an ordinary collaborator account. Confirm it sees only its own projects and that signing out closes access to them. Owner/admin accounts manage invitations; they are not needed for normal work.
3. Open **Assistant settings**, save the account's provider key, and confirm the available models appear. The RCP key portal is [portal.rcp.epfl.ch/aiaas/keys](https://portal.rcp.epfl.ch/aiaas/keys).
4. Create a disposable project, edit a small theorem, and wait for **All changes saved**. Reload and confirm the edit remains. Introduce a deliberate type error and check that Lean diagnostics arrive; undo it afterward.
5. Check the project, then move it to Trash while a check or terminal is active. The app should stop its work and finish the move. Restore it and confirm the saved file returns.

Verify the proxy's upload and streaming settings using [Hosting](Hosting.md). A healthy `/health` endpoint alone does not check sign-in, WebSockets, streaming, account isolation, or access outside the server's network.

## Check preparation and cache reuse

Wait for Lean, Mathlib, CSLib, and Physlib to show **Ready** in the project picker. On a fresh installation, prepare them with:

```sh
node --env-file=.env scripts/bootstrap-presets.mjs
```

Use a disposable project for each required library and check its default imports. A second Mathlib Playground should reuse the prepared environment without downloading or rebuilding the library. Existing projects must keep their original Lean version.

For repeatable Linux checks against your configured worker, run these from the app directory with Docker access and spare CPU/RAM:

```sh
node --env-file=.env scripts/check-runtime.mjs
node --env-file=.env scripts/check-worker-memory.mjs
node --env-file=.env scripts/check-project-setup.mjs
LEAN_PROBE_TEST_IMAGE=your-worker:tag node --env-file=.env scripts/check-shared-dependencies.mjs
LEAN_PROBE_TEST_IMAGE=your-worker:tag node --env-file=.env scripts/check-lean-probe.mjs
LEAN_PROBE_TEST_IMAGE=your-worker:tag node --env-file=.env scripts/check-repaired-editor.mjs
node --env-file=.env scripts/check-prepared-libraries.mjs
node --env-file=.env scripts/check-playground.mjs
```

Replace `your-worker:tag` with the installed `LEMEX_WORKER_IMAGE`. These checks create isolated fixtures and make no model requests. LeanProbe checks valid, invalid, and unfinished proofs with each library's full default import, repeated snippets, retained theorem caches, and memory-limit events. Append library IDs to focus the LeanProbe or prepared-library check, for example `mathlib cslib`. The prepared-library check opens two disposable projects per library, compiles their default imports offline, checks cache reuse, and cleans up its projects. The playground check uses the configured data directory's prepared Mathlib environment and also cleans up its temporary projects. Runtime and shared-dependency checks may download a missing test toolchain. Reports remain under `.runtime/` and must not be published without review.

The worker-memory check uses two small offline workers. It verifies enforced CPU, RAM, process, and swap limits, then exceeds one worker's 96 MiB allowance. The other worker must keep running and a subsequent job must succeed. It uses a temporary data directory and saves its report to `.runtime/worker-memory-check/result.json`.

The project-setup check covers TOML and Lean Lake files, unfinished proofs, setup repair, refresh, and native targets. It also checks imports outside the default build targets and dependencies stored in local folders. It opens real editor goals and hover information, compiles an assistant snapshot, and starts Lemex without sending a model request. Configuration pins and source files must remain unchanged.

Include a fresh public dependency download, two simultaneous imports reusing its cache, and the helper's proof checks with:

```sh
node --env-file=.env scripts/check-project-setup.mjs --dependencies --probe
```

The proof checks must accept a valid proof and reject both an invalid proof and `sorry`. Use `--toolchain leanprover/lean4:v4.35.0` to select another pinned release; `--probe` requires a compatible REPL bundled in the worker. Each run saves a separate report under `.runtime/project-setup-check/`. Set `LEAN_TEST_REPORT_DIR` to use another temporary location.

To reuse an installed toolchain without downloading it, set `LEAN_TEST_TOOLCHAIN_DIR=/path/to/toolchains` for the project-setup and shared-dependency checks. Set `STUDIO_WORKER_MEMORY=4g` to check setup at the ordinary worker default.

LeanProbe's check uses a 6 GiB limit by default; set `LEAN_PROBE_TEST_MEMORY` to match your worker limit when comparing capacity. Whole-snippet checks release temporary imports after each request; repeated theorem edits retain their warm environment. This prevents separate snippet imports accumulating; complex proofs and large projects can still exceed the worker limit.

The repaired-editor check verifies real compiler/editor isolation and starts Lemex offline with the production RCP feature settings. It checks that strict configuration accepts them and that the native runtime disables subagents and concurrent reasoning summaries, without sending a model turn.

For a large, pinned imported repository with both cold and warm setup, see [Check a large imported project](LargeProjectChecks.md). A small proof check does not establish that every large project fits the server's CPU, memory, or disk limits.

## Check PDF compilation

If PDF compilation is enabled, first build the [optional TeX worker](Configuration.md#latex-compilation), then run:

```sh
node --env-file=.env scripts/check-tex-runtime.mjs
```

This Linux check uses the configured `STUDIO_TEX_IMAGE` and its own temporary data directory. It compiles a multi-file document with a bibliography, checks PDF/text output, diagnostics and recovery, and verifies cancellation, timeouts, and compiler isolation. It makes no model requests and removes its fixtures after successful cleanup. The report is `.runtime/tex-runtime-check/result.json`; a cleanup failure records the remaining fixture directory.

## Check changes before deployment

Use the [local and CI checks](Automation.md#run-checks-locally) for server regressions, browser behavior, types, lint, dependencies, and the production client. Browser fixtures cover slow streams, account recovery, autosave conflicts, provider settings, and cache invalidation without using a real model key.

A real assistant request uses the account's provider allowance. If you perform one, use a disposable project and confirm the response streams, **Stop** works, and the selected model and reasoning setting are honored. With a single-request RCP key, a second chat should wait with a clear message and remain cancellable; background naming must not interrupt it. A key used outside this LeanFlow instance can still encounter the provider's limit.

Before switching releases, take a [consistent backup](Configuration.md#back-up-before-upgrading), wait for active work to finish, and retain the previous app/worker for rollback. Repeat the shared-address checks after restarting. Share each person's access token privately; their provider API key is entered by them, not sent with the invitation.

[Historical verification records](VerificationHistory.md) describe earlier tested versions and are not evidence for the currently running deployment.
