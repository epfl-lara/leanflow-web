# Lemex Lean Studio

A self-hosted Lean editor with persistent projects, Git import, an infoview, and a Lemex assistant. The initial deployment is for the machine owner and trusted collaborators. Projects and assistant sessions live under the application data directory rather than the upstream `Projects` examples.

## Run on larapc2

Requirements: a Linux host, Node 24+, Python 3.11+, Docker Engine, and enough disk for Lean dependency caches. Docker commands run under the server account. On larapc2, the supported Node executable is `/localhome/milikic/miniconda3/bin/node`.

```bash
cd /localhome/milikic/lemex-web
export PATH=/localhome/milikic/miniconda3/bin:/localhome/milikic/.local/bin:/usr/bin:/bin
CYPRESS_INSTALL_BINARY=0 npm ci
scripts/build-worker.sh
node scripts/bootstrap-presets.mjs
npm run build:client
scripts/run-studio.sh
```

The web server binds to `127.0.0.1:8090` by default. It creates `.data/auth/owner.token` on first startup. Read that file locally and paste its token into the sign-in screen. Keep tokens private; the server stores SHA256 hashes in `users.json`, and sessions use an HTTP-only cookie.

Access it from another computer through SSH:

```bash
ssh -L 8090:127.0.0.1:8090 milikic@larapc2
```

Then open `http://localhost:8090`. The sidebar provides project creation, pinned library presets, and a Git URL import flow. The file tree and editor remain available beside the assistant so changes can be reviewed in context.

Add a trusted collaborator locally:

```bash
node scripts/add-user.mjs "Collaborator name"
```

The helper prints the new account token once. The account list refreshes on sign-in. Each account owns its projects; cross-account project sharing is a later extension.

## Four assistant sections and optimization

| Section | Task |
|---|---|
| Proofs | Repair an incorrect proof or find a complete proof while preserving its statement. |
| Formalize | Translate the requested mathematics into Lean statements and proofs; review their mathematical meaning. |
| Optimize | Refactor existing valid theorem/lemma proof bodies while preserving statements and surrounding code. |
| Search | Ask the assistant to find declarations or explanations without changing project files; direct Loogle/LeanExplore lookup is also available. |

Optimization compares the saved baseline with the independently verified candidate under the same project's exact Lean toolchain and dependency pins. It reports named theorems, proof-body token counts, raw heartbeats, and totals, keeping negative reductions visible. A shorter proof can require more elaboration work. An unsupported declaration shape or measurement failure is shown as unavailable rather than assigned a guessed cost; a failed baseline proof should be repaired first.

The token convention mirrors the [pinned Arena tokenizer](https://github.com/delta-lab-ai/lean-refactor/blob/9c98a3a097e53724e35b2a2e7fe316c331efa20a/lean_refactor/cc_agent/scripts/proof_utils.py), including its operator merging, nested comment handling, and proof-body-only scope. The full provenance pin is `9c98a3a097e53724e35b2a2e7fe316c331efa20a`, as recorded by `TOKENIZER_SOURCE` in the local proof-reduction-competition verifier. Heartbeats adapt that verifier's synchronous `IO.getNumHeartbeats` command wrapper with `Elab.async=false` and `maxHeartbeats=0`; wall time and `--profile` are not heartbeat measurements. Displayed Lean heartbeats divide the raw counter by 1,000.

`server/optimization.mjs` resolves the Lake environment before measurement, then uses the pinned Lean binary directly. Both workers have read-only project/home mounts, a fresh private home, no provider environment, and no network. Local imported modules are rebuilt from their current sources into `/tmp`; instrumented modules and their output libraries are temporary. Source context is retained, and Lean checks each wrapped command's exact UTF-8 end position. The competition backend, datasets, reference caches, and experiment results are not used or modified. These measurements are local project costs, not official Arena scores or compatibility results for other toolchains.

`prompts/proof-optimization.md` encourages library lemma reuse, focused proof steps, and explicit tradeoffs. The compiler-only fixture in `scripts/check-optimization.mjs` demonstrated **11→7 tokens**, with raw heartbeats **38,220→38,353** in Lean basics and **39,336→39,416** in Mathlib. This is a measured length improvement with a slight heartbeat regression, not an improvement on both axes. See [verification evidence](Verification.md) for the recorded artifact and exact checked scope.

## Chats, selected files, and run controls

Use **New chat** to start an empty conversation or the chat selector to reopen an existing project chat. Chats are owned by the signed-in account and scoped to their project. Earlier user/assistant text from the selected chat is carried into a fresh native Lemex run as bounded conversation context: at most 12 earlier runs and 60,000 characters, with per-entry limits. It is not imported as privileged instructions, proof evidence, or native home state. Current saved files are authoritative, and each run must check them again. Personal Lemex sessions and unrelated chats are not loaded.

An empty chat offers two compact suggestions for the selected task. For example, Optimize offers **Shorten the proof** and **Reduce heartbeats**. Selecting a suggestion fills and focuses the message box while keeping the current task type; edit it before running.

**Select files** attaches up to 12 exact saved paths. Read-only library sources can provide context; they remain read-only. The active editor file is also supplied to the run. Starting a run saves the current dirty buffer before capturing its source snapshot. Only one assistant run can be active in a project.

The default **Until done** setting applies no application wall-clock cap. Choose 2, 5, 15, or 30 minutes to add a cap, or use **Stop** to cancel. The backend also accepts an explicit cap from 30 to 1,800 seconds. Finite caps include snapshot preparation and optimization measurements as well as the native task and verification. Runs still end on native completion, failure, cancellation, or server interruption; interrupted runs are not automatically restarted.

The **Reasoning traces** setting controls capture for new runs. The interface renders reasoning text or summaries actually emitted by the selected model/runtime, separately from assistant messages and tool activity. A model may expose neither; the application does not generate missing traces. Assistant Markdown is rendered without raw HTML, and image references are links rather than automatic external image loads.

## Live saved edits, review, and Undo

**Edit files live** is enabled by default for proof, formalization, and optimization tasks. Validated source-file updates from the isolated agent workspace are mirrored into the actual saved project as the agent works. A clean open editor updates its existing Monaco model so Lean sees the edits without restarting the language server. An unsaved editor buffer is preserved and receives a notice if the saved file changes underneath it. Live edits are intermediate work; the final result still needs independent Lean verification. **View edits** shows the diff and verification result.

After the run stops, **Undo agent edits** restores the files that the run changed. The server checks their current contents before restoring them, preserves unrelated saved source and text edits, and refuses to overwrite conflicting user changes. Stop any active run in the project first; the interface also pauses Undo for a dirty editor buffer. Run changes and recovery records remain in owned application storage.

Disable **Edit files live** to keep edits in a separate candidate. Review its diff and verification result, then explicitly **Apply changes**. Proof and optimization candidates must pass the integrity checks before acceptance. Apply is paused for an unsaved editor buffer; explicit discard restores only that buffer and sends no file-save request. In this review-first workflow, acceptance also checks the original saved snapshot for changes. A conflicting saved edit requires a new run against the current project. Live-mode conflicts likewise stop mirroring rather than overwrite saved work.

## Layout, themes, and recoverable deletion

Drag the separators to resize the file/project regions, editor goals, and assistant. Separators also support keyboard arrows, Home/End, and double-click reset. Layout choices persist locally. The goals view follows initial light/dark theme selection and subsequent toggles, including an explicit iframe background and readable binder/turnstile colors.

Delete controls are available for writable project files and folders, projects, and the selected chat. They open a confirmation and move the item to recoverable **Trash**. Use the immediate **Undo** notice or open Trash and **Restore**. Restoring files does not overwrite existing paths. Chat deletion archives its conversation and saved runs together; restoration returns that same history. Stop an active run before deleting or restoring its chat. Library dependency files cannot be deleted through these controls.

## Provider configuration

The server uses an independent provider configuration at `.data/provider.json` with permissions `0600`. The first startup can initialize it from `LEMEX_API_KEY` and `LEMEX_BASE_URL` in the server environment. Provider keys stay on the server and enter only the relevant assistant worker's environment; they are not passed to ordinary Lean checks or sent to the browser. Model catalog metadata is packaged without credentials.

Set `STUDIO_MODEL` to override the configured default model. The larapc2 default follows the current Lemex configuration, `deepseek-ai/DeepSeek-V4.1-Flash`. Configure a provider endpoint and authentication appropriate to that model. Agent runs incur the configured provider's usage charges.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8090` | Web port |
| `STUDIO_DATA_DIR` | `.data` in this checkout | Persistent account, project, job, and cache directory |
| `STUDIO_ORIGIN` | Local origin | Expected browser origin when deployed behind HTTPS |
| `STUDIO_MODEL` | Current configured model | Assistant default |
| `STUDIO_MAX_WORKERS` | `6` | Active application worker limit |
| `LEMEX_WORKER_IMAGE` | `lemex-web-worker:local` | Isolated Lean and Lemex runtime |

The server package defines the application API, and `server/runtime.mjs` owns worker execution. Run a distinct `STUDIO_DATA_DIR` when testing so production projects and sessions are untouched.

## Native Lemex and tools

The packaged runtime is the latest verified upstream Lemex revision at implementation time:

```
2f0e12c10d0baf7404a83da3b8cb8f04b77822c9
```

`scripts/package-lemex.py` verifies both `source_commit` and `native_build_commit` against the requested commit, checks that Lemex is a native ELF executable, and copies only native runtime assets plus an allowlisted configuration and model catalog. It does not copy host authentication, history, session databases, trusted-project lists, hooks, MCP secrets, or home directories. `.runtime/lemex/manifest.json` records SHA256 hashes. The user's installed Lemex remains unchanged. The final bundle uses the already installed native `dev-small` build at this commit. Its CLI embeds the full compiled commit, and both native binaries match the existing Cargo artifacts by SHA256. When upstream installation metadata is absent, packaging verifies a clean checkout at the requested commit, those artifact hashes, and the compiled CLI stamp, then records that evidence in the owned bundle. It does not rebuild or restamp an older executable.

Worker tools:

- `/opt/lemex/bin/lemex`: native app-server and CLI.
- `/opt/tools/bin/lean-lsp-mcp --lean-project-path /workspace`: Lean goals, diagnostics, builds, tactic trials, and declaration searches including Loogle.
- `/opt/tools/bin/lean-explore mcp serve --backend api`: hosted semantic declaration search.
- `lean`, `lake`, Git, ripgrep, Python, Node, and uv.

The image pins `lean-lsp-mcp==0.31.0`, `lean-explore==1.3.0`, and `uv==0.13.0`. Lean LSP MCP and LeanExplore use separate Python environments because their MCP package requirements conflict. Both command-line interfaces are checked during image construction. Hosted search results may describe a different library revision; candidates must compile against the active project's exact dependencies. At implementation-time verification, LeanExplore's hosted endpoint denied larapc2 requests with HTTP 403 (Cloudflare browser-signature policy). Its integration remains available, and failures are reported; Loogle and local Lean diagnostics provide working alternatives.

To update Lemex, install and verify a native revision separately, then run `scripts/build-worker.sh --source /path/to/native/runtime --expected-commit <full-commit>` and restart the server. If installation metadata is absent, also provide `--source-checkout /path/to/clean/repo --build-artifacts /path/to/cargo/profile`; the larapc2 defaults point to `~/lemex-fork` and `~/.cache/lemex-native-build/dev-small`. Native asset permissions are normalized only in the owned bundle so the container worker can execute root-owned Docker copies.

For a running service, stage with `LEMEX_RUNTIME_DIR=.runtime/lemex-next scripts/build-worker.sh ...`. Verify the staged image, then stop the service and adopt the staged bundle before restarting. Active runtimes pin their image ID and cache the native provenance read from that exact image, so repackaging or retagging does not change the revision reported by a live runtime.

## Pinned dependency presets

`server/presets.json` pins every library to an immutable Git commit:

| Preset | Lean toolchain | Library commit |
|---|---|---|
| Lean basics | `leanprover/lean4:v4.34.1` | Lean standard library |
| Mathematics · Mathlib | `leanprover/lean4:v4.35.0-rc4` | `105b9b1ce126e77b467aac6f6ba36b510ac57368` |
| Computer science · CSLib | `leanprover/lean4:v4.35.0-rc4` | `5281222cc03740a7ebaa040c48c594f476018ce5` |
| Physics · Physlib | `leanprover/lean4:v4.34.1` | `89d99e898104b7ffd93df322e0ab1ea999645116` |

The library presets preserve their transitive dependency pins. They are separate environments because their current toolchain and Mathlib requirements differ. A preset is marked ready only after its default library import compiles with network access disabled.

`node scripts/bootstrap-presets.mjs lean` checks the minimal environment first. Running without arguments warms all libraries. Logs live under `.data/runtime/logs`. Bootstrap uses Mathlib's `lake exe cache get` and Physlib's `lake exe get_cache`; it then builds and checks `Main.lean`. Cache download failures are reported in the log, and the final build determines readiness. Interrupted preparation can be rerun: already verified presets are skipped.

The runtime registers existing host Lean release toolchains only through curated, read-only per-toolchain mounts and verifies each binary's version in a container. Missing versions install into the application's owned `.data/runtime/elan` cache. A worker sees only the registered toolchain directories, never the host's home directory.

Library artifacts occupy multiple gigabytes. The host filesystem does not support reflinks, so projects and candidate snapshots inherit dependency directories through read-only mounts instead of copying their complete contents. An actual Mathlib import and Lake build were checked against this arrangement. Physlib also enables Lake artifact caching. The runtime places that cache in the private home, then shares immutable source artifacts through read-only mounts and private symlinks while copying only small lookup maps. Candidate source files and newly generated artifacts remain private and writable. Keep template caches while projects reference them.

## Worker isolation and limits

Every Lean language server, Lake project evaluation, and assistant process runs in a Docker worker. Each worker has:

- Its source project mounted at `/workspace` and a private home at `/home/worker`.
- A read-only root filesystem and inherited dependency caches.
- No host home, Docker socket, or sibling project mounts.
- The server account's UID/GID, all Linux capabilities dropped, and `no-new-privileges`.
- CPU, memory, process, and temporary-directory limits.
- Whole-container cancellation, per-process owner labels, and stable data-directory/scope labels for restart cleanup.

Normal Lean commands have no network. Git import, dependency preparation, hosted search, and assistant inference use an outbound bridge network. This initial deployment does not enforce a domain-level egress allowlist; trusted imported Lake code and assistant tools can make outbound requests inside their workers. Assistant workers receive the provider API key in their environment. Commands and imported Lake code executed by that assistant can access it, so collaborators and imported sources must be trusted. Independent verification uses a separate source copy, fresh home, no provider credentials, and no network. Docker access belongs to the host server process; the deployment is intended for trusted collaborators rather than an anonymous public code-execution service.

The runtime defaults to six active workers, two CPUs, four GiB memory, and 512 processes per worker, with a bounded command queue. Preset warming uses two workers, four CPUs, and eight GiB per worker. Resource limits can be adjusted in the Runtime constructor for the host's capacity.

## Restart recovery

The command-line server obtains an exclusive `.data/server.pid` lease before creating its runtime. A second live server using the same data directory is refused. The lease records the Linux boot ID and process start time, so a stale file cannot mistake a reused PID for a live server; concurrent startup is serialized and cleanup requires the matching lease token. The server runtime has scope `server`; bootstrap and validation helpers have scope `helper` by default. On startup, only orphan containers carrying the same canonical data-directory and server-scope label are removed. Helper/bootstrap workers and other data directories are preserved. Graceful shutdown removes only the current process owner's containers. Unfinished job records become `interrupted` and are not automatically rerun.

Dependency and toolchain registry updates merge the latest on-disk values under an OS file lock, then replace the JSON file atomically. Live imports and separate cache-warming helpers therefore preserve one another's registrations.

## HTTPS and a durable service

`deploy/lemex-web.service` is a user-service example for larapc2's paths. Review its working directory and Node path, then copy it to `~/.config/systemd/user/lemex-web.service`, reload the user manager, and enable it. Docker Engine must already be running, and the account must have access to its socket. This user service is installed and enabled on larapc2; user lingering is enabled so it continues after logout. Use `systemctl --user status lemex-web.service` and `journalctl --user -u lemex-web.service` for status and logs. `.data/server.env` is an optional mode-`0600` environment file.

For a public hostname, use an HTTPS reverse proxy. `deploy/Caddyfile.example` forwards to the loopback server. Set `STUDIO_ORIGIN=https://your-hostname` so WebSocket and request origin checks match the external address. Keep account allowlisting enabled. Service installation and reverse-proxy changes are explicit deployment steps.

Back up `.data/auth`, `.data/provider.json`, workspace metadata, source projects, and saved jobs. Dependency caches and native runtime assets can be reproduced from the pinned manifests, but they must remain present during a live run. Stop jobs or capture a consistent snapshot before moving data. Preserve restrictive permissions for backups containing provider credentials or login tokens.

## Verification

Assistant output is rebuilt in a verification copy captured from the saved project, with only validated Lean changes applied. Verification receives a fresh home and artifacts, uses `python3 -I` for its audit helper, and runs with network access disabled. The trusted baseline Lake environment is resolved before building candidate code. Source/configuration fingerprints must remain unchanged during that build. The audit then uses the pinned Lean binary directly in another worker with a fresh read-only home and read-only project; it does not reevaluate build-controlled Lake files. Changed modules and their project-local imports compile from source into separate audit artifacts, and `leanchecker -v <Module>` replays every one through Lean's kernel. Existing project-local compiled artifacts are excluded from the audit search path; pinned library artifacts remain trusted imports. Axiom inspection checks for unfinished proofs and unexpected axioms. Kernel replay is part of the integrity check; formalized statements still need human review for mathematical intent. Repair/prove/optimize modes conservatively preserve existing statements and surrounding assumptions and reject commands hidden inside proof spans. Assistant changes containing executable metaprogramming (`run_tac`, `run_cmd`, `#eval`, and related constructs) require manual review. Apply and live Undo protect unsaved buffers and conflicting saved edits as described above; a verification badge does not authorize overwriting newer user work.

```bash
npm test
npm run check
node scripts/check-runtime.mjs
node scripts/check-verification.mjs
node scripts/check-optimization.mjs
```

This compiles a real Lean proof and replays it through the kernel, checks writable project/private-home isolation and read-only system files, and tests read-only dependency/artifact sharing, per-process secret scoping, and cancellation of a worker containing a child process. It asserts that cancelled containers have been removed, concurrent registry updates preserve each other, and server restart cleanup preserves helper and unrelated workers. It also verifies that the native Lemex command runs inside the image. The preset bootstrap adds full default-library import checks. Application and browser tests cover the separate workspace API, editor/infoview, assistant protocol, and diff-review flow.

`node scripts/check-application.mjs` uses the real configured provider and creates an isolated repair example. `node scripts/check-browser.mjs` creates a separate browser fixture and needs Playwright Chromium (`npx playwright install chromium`). To verify unsaved-edit review against a real candidate, run `STUDIO_TEST_REVIEW_ONLY=1 node scripts/check-application.mjs`, then `STUDIO_REVIEW_PROJECT=<printed-project-id> node scripts/check-browser.mjs`. The browser test reviews and accepts that candidate. These application checks incur provider usage; runtime and compiler regressions do not. See [the recorded release evidence](Verification.md).
