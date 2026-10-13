# LeanFlow Web deployment and configuration

A self-hosted Lean editor with persistent projects, Git import, an infoview, and a Lemex assistant. The initial deployment is for the machine owner and trusted collaborators. Projects and assistant sessions live under the application data directory rather than the upstream `Projects` examples.

Developed by [EPFL LARA](https://lara.epfl.ch/).

## Install and run

Requirements: Linux, Node.js 24+, Python 3.11+, Git, Docker Engine accessible to the server account, and disk space for Lean dependency caches. Prepare a verified native Lemex installation and its model catalog as described in [Native Lemex and tools](#native-lemex-and-tools).

```bash
git clone https://github.com/epfl-lara/lemex-web.git
cd lemex-web
CYPRESS_INSTALL_BINARY=0 npm ci
npm run worker:build -- --source /path/to/native/lemex --config /path/to/lemex/config.toml
npm run presets:install
npm run build
cp .env.example .env
chmod 600 .env
```

Edit `.env` with your provider settings, then start the server:

```bash
node --env-file=.env server/studio.mjs
```

`npm start`, `npm run dev`, and `scripts/run-studio.sh` use the process environment; they do not load `.env` themselves. The systemd example instead reads `.data/server.env` explicitly. Never commit either file. Node's `--env-file` option uses existing exported environment values in preference to values in the file.

The web server binds to `127.0.0.1:8090` by default. It creates `.data/auth/owner.token` on first startup. Read that file locally and paste its token into the sign-in screen. Keep tokens private; the server stores SHA256 hashes in `users.json`, and sessions use an HTTP-only cookie. If your session expires while working, sign in again with the same account's token in the recovery dialog. Unsaved editor text and chat drafts stay open; retry the interrupted action after signing in.

Access it from another computer through SSH:

```bash
ssh -L 8090:127.0.0.1:8090 user@your-server
```

Then open `http://localhost:8090`. The sidebar provides project creation, pinned library presets, and a Git URL import flow. The file tree and editor remain available beside the assistant so changes can be reviewed in context.

Add a trusted collaborator locally:

```bash
node --env-file=.env scripts/add-user.mjs "Collaborator name"
```

The helper prints the new account token once. Use the same environment file or exported `STUDIO_DATA_DIR` as the server (for systemd, `--env-file=.data/server.env`). The account list refreshes on sign-in. Each account owns its projects; cross-account project sharing is a later extension.

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

Use **New chat** to start a draft or the chat selector to reopen an existing project chat. A new conversation enters the chat list when you send its first message. Chats are owned by the signed-in account and scoped to their project. Earlier user/assistant text from the selected chat is carried into a fresh native Lemex run as bounded conversation context: at most 12 earlier runs and 60,000 characters, with per-entry limits. It is not imported as privileged instructions, proof evidence, or native home state. Current saved files are authoritative, and each run must check them again. Personal Lemex sessions and unrelated chats are not loaded.

New chats receive a short DeepSeek title in the background after their first message. The initial prompt supplies a fallback if naming is unavailable. Use the **Rename chat** pencil beside the selector to enter your own name, or choose **Suggest with DeepSeek**, edit its suggestion, and **Save**. Naming keeps the same conversation, context, and draft, including during an active proof run. A manual name always takes precedence over a pending automatic title. Existing conversations are not renamed automatically.

Title generation is a separate text-only request using the configured DeepSeek model (or an available DeepSeek Flash model), at its lowest supported reasoning effort. It receives a bounded sample of user/assistant messages; no source files, tool output, reasoning traces, or project instructions are added. It has no tools or worker access and does not change proof-agent limits. At most two naming requests run concurrently, duplicate requests for the same chat share a result, and failures keep the existing name. Restarting does not replay naming requests.

An empty chat offers two compact suggestions for the selected task. For example, Optimize offers **Shorten the proof** and **Reduce heartbeats**. Selecting a suggestion fills and focuses the message box while keeping the current task type; edit it before running.

Type **@** in the composer to find a project file, or use **Select files** to attach up to 12 exact saved paths. Arrow keys, Enter, and Escape control the mention picker. Read-only library sources can provide context; they remain read-only. The active editor file is also supplied to the run. Starting a run saves the current dirty buffer before capturing its source snapshot. Only one assistant run can be active in a project.

To work on one proof, use the **Outline** below **Files** in the left sidebar. Entries show their declaration type and line number; clicking one navigates to its source, and **+ Chat** attaches it to the current chat without changing your task mode. **Ask Lemex** and **Optimize** use the current editor proof or selected lines and explicitly select their corresponding modes. Imports provide navigation only. Drag the separator to give Files or Outline more space.

You can also use **Focus proof / lines** beside **Select files** below the chat message. Choose a named declaration, use the editor selection/current proof, or enter a line range such as `70–74`. Check the visible **Focused on** name and file/line range, then send your message. Remove the target with its clear button or click its label to return to the source. Targets stay with their own chat drafts and are recorded beside sent messages. The outline comes from Lean's language server; line selection also works when the outline is unavailable. Library sources remain read-only.

Proof targets capture complete selected lines from the editor. Starting a new task saves the current buffer first. A focused update during a running task requires a clean editor and matching saved and agent sources; stop the task first if you want it to start from your unsaved edits. If the selected lines have changed, the server asks you to select the proof again and keeps your draft. Queued runs check the captured project once more before launching Lemex. Focus tells the assistant which statement to work on while keeping surrounding project context available; ordinary project isolation and independent proof verification still apply.

Runs have no application time cap in the interface. **Options → Reasoning effort** offers only levels supported by the selected Lemex model. **Send update** queues additional instructions into the current native turn, with explicit pending/accepted/failed receipts. Accepted means the native runtime accepted the update for its next decision, not that the model has already read it. **Stop** remains visible and displays **Stopping…** until the worker and pending live edits are finished. Then Send can continue the same chat. Legacy API clients may explicitly request a finite cap; the browser always sends `maxSeconds=null`.

The **Reasoning traces** setting controls capture for new runs. The interface renders reasoning text or summaries actually emitted by the selected model/runtime, inline with the corresponding conversation turn, with expand/collapse controls. Usage shows readable token categories; Raw data retains the original runtime record. A model may expose neither; the application does not generate missing traces. Assistant Markdown is rendered without raw HTML, and image references are links rather than automatic external image loads.

While Lemex works, scroll up to read without incoming output moving your view. **Jump to latest** resumes following the output; sending a message also returns to the latest output in that chat. Reasoning and activity start collapsed and keep your open/closed choice through updates. Streaming text uses a lightweight plain-text display; completed messages render Markdown. **Stop** stays above the conversation. You can navigate files, switch chats, and draft the next message during a run; submitting another task in the same project waits for the current one to stop.

Task options collapse when opening a run to leave more space for messages. Open **Options** to change the model, reasoning effort, or live-edit preference for the next submission. Options are collapsed by default, including in empty chats. Typed drafts, task type, and selected files are retained separately for each signed-in account, project, and chat.


## Import, upload, and setup repair

Paste a public HTTPS repository URL or a GitHub `tree/<revision>/<directory>` link into **Repository**. The importer retains the checkout but runs Lean and exposes source files inside the selected Lean subdirectory. Git status, diff, and commits are restricted to that subdirectory. For a branch containing slashes, use an encoded branch segment or set **More options → Branch or revision** explicitly. Uploaded folders detect a unique nested `lean-toolchain`; ambiguous folders ask for a subdirectory.

**Upload** accepts files or folders from the chooser or drag-and-drop, up to 5,000 UTF-8 files, 2 MiB per file and 20 MiB in total. The client excludes Git/build caches and known private settings before sending. The Files header also uploads into the open project. Existing names cause an explicit conflict; files are never silently overwritten.

**Let Lemex repair setup if needed** is enabled for new imports/uploads and can be disabled. After deterministic setup fails, the server announces one repair attempt in a disposable copy. Only the root `lean-toolchain`, `lakefile.lean`, `lakefile.toml`, and `lake-manifest.json` may be copied back. Proof/source changes or symlinks are rejected. Agent and repair copies omit Git metadata at every directory depth. Original configuration is retained under `.data/setup-repairs/<attempt>/changes.json`, outside writable worker mounts. The repaired configuration is first evaluated in its disposable copy and compared again for source changes. Normal checks then run with the original project source mounted read-only and only its `.lake` build directory writable; pre-existing cache hardlinks are rejected. A model's success claim alone cannot mark setup ready. Later Check Lean and language-server workers retain this read-only source policy for repaired projects. **Stop setup** cancels that attempt; it stops waiting for a shared toolchain download without cancelling a cache download another project may need.

New projects allow selecting multiple installed libraries and display the Lean version used by the selected combination. Mathlib + CSLib uses CSLib's tested Mathlib revision; Mathlib + Physlib uses Physlib's tested revision. Current CSLib and Physlib presets use different Lean versions, so that combination is disabled with an explanation. Imports keep their own lockfiles. Fresh preset installation verifies the combined `Mathlib` and `Cslib`/`Physlib` imports before marking those presets prepared.

LeanProbe is pinned to `646cb0ee3d428562b13740649aa7c1689ec0720a`, with `lean-interact==0.11.5` in its own environment. Its private worker-home cache uses packaged, pinned REPL source for Lean 4.29.0, 4.34.1, and 4.35.0-rc4; other releases follow LeanInteract's normal versioned build/download path. `LEAN_PROBE_AUTO_BUILD=0` keeps build output out of MCP stdout. Both `success` and `ok` must be true for a successful proof check; independent kernel verification still decides final acceptance.

## Live saved edits, review, and Undo

**Edit files live** is enabled by default for proof, formalization, and optimization tasks. Validated source-file updates from the isolated agent workspace are mirrored into the actual saved project as the agent works. A clean open editor updates its existing Monaco model so Lean sees the edits without restarting the language server. An unsaved editor buffer is preserved and receives a notice if the saved file changes underneath it. Live edits are intermediate work; the final result still needs independent Lean verification. **View edits** shows the diff and verification result.

After the run stops, **Undo agent edits** restores the files that the run changed. The server checks their current contents before restoring them, preserves unrelated saved source and text edits, and refuses to overwrite conflicting user changes. Stop any active run in the project first; the interface also pauses Undo for a dirty editor buffer. Run changes and recovery records remain in owned application storage.

Disable **Edit files live** to keep edits in a separate candidate. Review its diff and verification result, then explicitly **Apply changes**. Proof and optimization candidates must pass the integrity checks before acceptance. Apply is paused for an unsaved editor buffer; explicit discard restores only that buffer and sends no file-save request. In this review-first workflow, acceptance also checks the original saved snapshot for changes. A conflicting saved edit requires a new run against the current project. Live-mode conflicts likewise stop mirroring rather than overwrite saved work.

## Layout, themes, and recoverable deletion

Drag the separators to resize the file/project regions, editor goals, and assistant. Separators also support keyboard arrows, Home/End, and double-click reset. Layout choices persist locally. The goals view follows initial light/dark theme selection and subsequent toggles, including an explicit iframe background and readable binder/turnstile colors.

Delete controls are available for writable project files and folders, projects, and the selected chat. They open a confirmation and move the item to recoverable **Trash**. Use the immediate **Undo** notice or open Trash and **Restore**. Restoring files does not overwrite existing paths. Chat deletion archives its conversation and saved runs together; restoration returns that same history. Stop an active run before deleting or restoring its chat. Library dependency files cannot be deleted through these controls.

## Source control and publishing

Open **Source control** in the project sidebar to review saved changes. Tracked files show a diff; new text files show their contents. A dirty editor must be saved and reviewed again before committing. Enter a commit message and optionally set the author name/email. The server checks the reviewed files and current revision before committing, so a stale review requires a refresh. A subdirectory project commits only its admitted project files. **New branch** creates a local branch; an imported detached revision needs a named branch before publishing.

The **Publish** tab accepts a public HTTPS repository URL and destination branch. **Preview push** prepares an isolated copy of the committed history and displays the exact commit and destination. Its history list is recent local history, not a claim about which commits the remote lacks. Unsaved and uncommitted changes are excluded. For a shallow public import, the server retrieves the missing history anonymously into the publishing copy; it does not rewrite the project checkout.

After reviewing the preview, enter a repository token with permission to push to that destination, and optionally its username. The token is used for that request only and cleared from the form as the request starts. Publishing never force-pushes. A rejected push displays the Git error; create a new preview before retrying. Git mutations wait for active Lemex runs, checks, and preparation to finish. Ordinary editor saves remain available during network transfer. You can close Source control while an operation continues and reopen it to refresh the repository status.

Publishing is handled by the server, outside the proof agent. Only exported Git objects and server-created configuration enter the credentialed worker. Project hooks, source files, Git configuration, provider credentials, and agent state are absent. The token travels through stdin to a trusted wrapper, enters only the Git process environment, and is not saved to disk or supplied in Docker arguments/environment. HTTPS certificate checks remain enabled; the destination resolves to public addresses, is pinned for the request, and cannot redirect or use a proxy. The default destination comes from server-owned import metadata or a previously selected destination, never from worker-editable Git configuration. Previews expire after ten minutes, bind the reviewed commit/destination, and are consumed by a publish attempt. Export bundles are limited to 512 MiB. This workflow does not add private repository import or GitHub account connections.

## Provider configuration

The server uses an independent provider configuration at `.data/provider.json` with permissions `0600`. Startup reads `LEMEX_API_KEY` and `LEMEX_BASE_URL` from the server environment or the saved provider file, and persists updated credentials when a key is supplied. Provider keys stay on the server and enter only the relevant assistant worker's environment; they are not passed to ordinary Lean checks or sent to the browser. Model catalog metadata is packaged without credentials.

Set `STUDIO_MODEL` to override the configured default model. The default follows the model in the installed Lemex configuration, falling back to `deepseek-ai/DeepSeek-V4.1-Flash` when none is configured. Configure a provider endpoint and authentication appropriate to that model. Agent runs incur the configured provider's usage charges.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8090` | Web port |
| `STUDIO_DATA_DIR` | `.data` in this checkout | Persistent account, project, job, and cache directory |
| `STUDIO_ORIGIN` | Local origin | Expected browser origin when deployed behind HTTPS |
| `STUDIO_MODEL` | Installed Lemex model, otherwise DeepSeek Flash | Assistant default |
| `LEMEX_API_KEY` | Saved provider value | Lemex RCP provider key; required for assistant requests |
| `LEMEX_BASE_URL` | Saved provider value | Provider API base URL; also used for chat naming |
| `LEMEX_HOME` | `~/.lemex` | Installed model configuration/catalog read by the server |
| `STUDIO_MAX_WORKERS` | `6` | Active application worker limit |
| `LEMEX_WORKER_IMAGE` | `lemex-web-worker:local` | Isolated Lean and Lemex runtime |

The server package defines the application API, and `server/runtime.mjs` owns worker execution. Run a distinct `STUDIO_DATA_DIR` when testing so production projects and sessions are untouched.

## Native Lemex and tools

This release was verified with native Lemex revision:

```
2f0e12c10d0baf7404a83da3b8cb8f04b77822c9
```

`scripts/package-lemex.py` verifies both `source_commit` and `native_build_commit` against the requested commit, checks that Lemex is a native ELF executable, and copies only native runtime assets plus an allowlisted configuration and model catalog. It does not copy host authentication, history, session databases, trusted-project lists, hooks, MCP secrets, or home directories. `.runtime/lemex/manifest.json` records SHA256 hashes. The user's installed Lemex remains unchanged. The recorded deployment used a native `dev-small` build at this commit. Its CLI embeds the full compiled commit, and both native binaries match the existing Cargo artifacts by SHA256. When upstream installation metadata is absent, packaging verifies a clean checkout at the requested commit, those artifact hashes, and the compiled CLI stamp, then records that evidence in the owned bundle. It does not rebuild or restamp an older executable.

Worker tools:

- `/opt/lemex/bin/lemex`: native app-server and CLI.
- `/opt/tools/bin/lean-lsp-mcp --lean-project-path /workspace`: Lean goals, diagnostics, builds, tactic trials, and declaration searches including Loogle.
- `/opt/tools/bin/lean-probe mcp`: warm Lean proof checks, complete declaration replacements, proof states, and tactic trials. Enabled by default; final server verification remains independent.
- `/opt/tools/bin/lean-explore mcp serve --backend api`: hosted semantic declaration search.
- `lean`, `lake`, Git, ripgrep, Python, Node, and uv.

The image pins `lean-lsp-mcp==0.31.0`, `lean-explore==1.3.0`, and `uv==0.13.0`. Lean LSP MCP and LeanExplore use separate Python environments because their MCP package requirements conflict. Both command-line interfaces are checked during image construction. Hosted search results may describe a different library revision; candidates must compile against the active project's exact dependencies. During the recorded host verification, the hosted LeanExplore endpoint returned HTTP 403. Search failures are reported in the interface; this historical observation does not establish availability from another host. LeanExplore is the default direct-search provider, with Loogle selectable as an alternative.

The native installation directory must contain `bin/lemex`, `bin/lemex-code-mode-host`, `codex-path`, and `codex-resources`. Supply its configuration with `--config`; that file must refer to a curated model catalog (or have a sibling `models.json`). The server also reads the installed model configuration/catalog from `LEMEX_HOME` (default `~/.lemex`), so set that environment variable when using a custom configuration directory. Provider inference uses Lemex's RCP provider; set `LEMEX_API_KEY` and `LEMEX_BASE_URL` appropriately for that provider.

A native installation with `lemex-install.json` must record matching `source_commit` and `native_build_commit`. Without that metadata, supply the exact clean source checkout and the matching Cargo artifact directory explicitly:

```bash
npm run worker:build -- \
  --source /path/to/native/lemex \
  --config /path/to/lemex/config.toml \
  --source-checkout /path/to/clean/lemex-source \
  --build-artifacts /path/to/cargo/dev-small \
  --expected-commit 2f0e12c10d0baf7404a83da3b8cb8f04b77822c9
```

The artifact directory must be named `dev-small` or `release`. Packaging compares both binaries with those artifacts and checks the compiled commit stamp; it never builds or changes the source checkout. To upgrade, install and verify another native revision separately, pass its full commit with `--expected-commit`, and rebuild the image. Native asset permissions are normalized only in the owned bundle so the container worker can execute Docker's root-owned copies.

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

Library artifacts occupy multiple gigabytes. Projects and candidate snapshots inherit dependency directories through read-only mounts instead of copying their complete contents; this also works on filesystems without reflink support. An actual Mathlib import and Lake build were checked against this arrangement. Physlib also enables Lake artifact caching. The runtime places that cache in the private home, then shares immutable source artifacts through read-only mounts and private symlinks while copying only small lookup maps. Candidate source files and newly generated artifacts remain private and writable. Keep template caches while projects reference them.

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

`deploy/lemex-web.service` is a user-service example for a checkout at `~/lemex-web`. Adjust the working/data directories and the `PATH` so `node` resolves to Node 24 or newer. Docker Engine must already be running, and the account must have access to its socket. The service reads `.data/server.env`; create it from the example, edit your provider settings, and restrict its permissions:

```bash
mkdir -p .data ~/.config/systemd/user
cp .env.example .data/server.env
chmod 600 .data/server.env
# Edit .data/server.env before starting the service.
cp deploy/lemex-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lemex-web.service
```

Use `systemctl --user status lemex-web.service` and `journalctl --user -u lemex-web.service` for status and logs. A host administrator can enable user lingering if the service should survive logout. Service logs may contain deployment paths or project details; keep them private. The service/unit filenames retain `lemex-web` to match the repository and existing installations; the displayed product name is LeanFlow Web.

### Access beyond localhost

Use an HTTPS reverse proxy and keep the application on `127.0.0.1:8090`. Trusted collaborators still sign in with their own access tokens; exposing the sign-in page does not grant access to projects. Decide whether the address should be reachable only through your institution's network/VPN or from the Internet, and configure the corresponding network access with the host/network administrator.

`deploy/leanflow-proxy.service` runs the official Caddy image through the existing Docker Engine as your user, so private config and certificate state remain readable by their owner. Its only host mounts are a dedicated Caddyfile, optional TLS certificates, and private proxy state. It uses a read-only filesystem, drops capabilities except `NET_BIND_SERVICE`, and has no Docker socket, project, account-token, or provider-credential mounts. The official binary's file capability allows this non-root process to bind ports 80/443; `no-new-privileges` would prevent that capability from taking effect. Host networking lets the proxy reach the loopback backend. Caddy's administration API is disabled; configuration changes require restarting the proxy. That reconnects browser streams without stopping backend proof jobs.

Prepare the proxy without starting it:

```bash
install -d -m 700 ~/.config/leanflow-web/proxy \
  ~/.config/leanflow-web/proxy/certs \
  ~/.local/share/leanflow-web/proxy/data \
  ~/.local/share/leanflow-web/proxy/config
cp deploy/Caddyfile.example ~/.config/leanflow-web/proxy/Caddyfile
chmod 600 ~/.config/leanflow-web/proxy/Caddyfile

# Review the selected official release, then pin its immutable digest locally.
docker pull caddy:2
CADDY_IMAGE="$(docker image inspect --format '{{index .RepoDigests 0}}' caddy:2)"
printf 'CADDY_IMAGE=%s\n' "$CADDY_IMAGE" > ~/.config/leanflow-web/proxy/proxy.env
chmod 600 ~/.config/leanflow-web/proxy/proxy.env
cp deploy/leanflow-proxy.service ~/.config/systemd/user/
```

The service requires `CADDY_IMAGE=caddy@sha256:<digest>` and a locally present image, so restarts cannot silently pick up a changed tag. Repeat the pull/review/pin process deliberately for updates. Keep the proxy's state directories private and persistent: `/data` holds certificate private keys and renewal state. Do not commit them or include them in shared logs.

Replace `lean.example.org` in your private Caddyfile with the chosen hostname. Its DNS must point at the server. For automatic public certificate issuance, the ACME authority must be able to reach the challenge ports (normally TCP 80 and 443); a working DNS record alone does not establish reachability. For an EPFL/VPN deployment with an institution-issued certificate, put its full chain and private key in the private `certs` directory and enable the example `tls` line. Arrange renewal with the certificate issuer. DNS-based ACME validation is another option when challenge ports cannot be public, but requires DNS control and an appropriately configured Caddy DNS module. See [Caddy's HTTPS requirements](https://caddyserver.com/docs/automatic-https).

Validate the edited configuration without starting a listener or contacting a certificate authority:

```bash
docker run --rm --pull=never --network none --read-only --cap-drop ALL \
  --user "$(id -u):$(id -g)" --cap-add NET_BIND_SERVICE \
  --tmpfs "/data:rw,nosuid,size=16m,uid=$(id -u),gid=$(id -g),mode=0700" \
  --tmpfs "/config:rw,nosuid,size=16m,uid=$(id -u),gid=$(id -g),mode=0700" \
  --mount "type=bind,src=$HOME/.config/leanflow-web/proxy/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
  --mount "type=bind,src=$HOME/.config/leanflow-web/proxy/certs,dst=/certs,readonly" \
  "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemd-analyze --user verify deploy/leanflow-proxy.service
```

Set `STUDIO_ORIGIN=https://your-hostname` in the application's private `.data/server.env`, including the port if HTTPS uses a nonstandard port. It must match the browser origin exactly; this enables Secure cookies and correct request/WebSocket origin checks. Only that configured browser origin is accepted for writes, so an old HTTP/SSH-tunnel page will no longer be the entry point. Wait until active proof runs and project setup have finished before restarting the backend to apply the setting. Once network access, certificates, and origin configuration are ready:

```bash
systemctl --user daemon-reload
systemctl --user restart lemex-web.service
systemctl --user enable --now leanflow-proxy.service
```

Check `systemctl --user status leanflow-proxy.service` and its private journal, then verify HTTPS, sign-in, live chat updates, and editor diagnostics from a separate computer on the intended network. Caddy handles WebSocket upgrades and flushes server-sent events immediately; the supplied configuration sets no stream deadline. See [Caddy's streaming behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming). A successful local check or installed unit does not prove public reachability. To remove external access, stop the proxy with `systemctl --user disable --now leanflow-proxy.service`; this leaves the backend and proof jobs running. Restoring the original HTTP entry point also requires removing `STUDIO_ORIGIN` and restarting the backend during an idle window.

Back up `.data/auth`, `.data/provider.json`, workspace metadata, source projects, and saved jobs. Dependency caches and native runtime assets can be reproduced from the pinned manifests, but they must remain present during a live run. Stop jobs or capture a consistent snapshot before moving data. Preserve restrictive permissions for backups containing provider credentials or login tokens.

## Verification

Assistant output is rebuilt in a verification copy captured from the saved project, with only validated Lean changes applied. Verification receives a fresh home and artifacts, uses `python3 -I` for its audit helper, and runs with network access disabled. The trusted baseline Lake environment is resolved before building candidate code. Source/configuration fingerprints must remain unchanged during that build. The audit then uses the pinned Lean binary directly in another worker with a fresh read-only home and read-only project; it does not reevaluate build-controlled Lake files. Changed modules and their project-local imports compile from source into separate audit artifacts, and `leanchecker -v <Module>` replays every one through Lean's kernel. Existing project-local compiled artifacts are excluded from the audit search path; pinned library artifacts remain trusted imports. Axiom inspection checks for unfinished proofs and unexpected axioms. Kernel replay is part of the integrity check; formalized statements still need human review for mathematical intent. Repair/prove/optimize modes conservatively preserve existing statements and surrounding assumptions and reject commands hidden inside proof spans. Assistant changes containing executable metaprogramming (`run_tac`, `run_cmd`, `#eval`, and related constructs) require manual review. Apply and live Undo protect unsaved buffers and conflicting saved edits as described above; a verification badge does not authorize overwriting newer user work.

```bash
npm test
npm run check
npm run lint
npm run build
node scripts/check-runtime.mjs
node scripts/check-verification.mjs
node scripts/check-optimization.mjs
```

This compiles a real Lean proof and replays it through the kernel, checks writable project/private-home isolation and read-only system files, and tests read-only dependency/artifact sharing, per-process secret scoping, and cancellation of a worker containing a child process. It asserts that cancelled containers have been removed, concurrent registry updates preserve each other, and server restart cleanup preserves helper and unrelated workers. It also verifies that the native Lemex command runs inside the image. The preset bootstrap adds full default-library import checks. Application and browser tests cover the separate workspace API, editor/infoview, assistant protocol, and diff-review flow.

`node scripts/check-application.mjs` uses the real configured provider and creates an isolated repair example. `node scripts/check-browser.mjs` creates a separate browser fixture and needs Playwright Chromium (`npx playwright install chromium`). To verify unsaved-edit review against a real candidate, run `STUDIO_TEST_REVIEW_ONLY=1 node scripts/check-application.mjs`, then `STUDIO_REVIEW_PROJECT=<printed-project-id> node scripts/check-browser.mjs`. The browser test reviews and accepts that candidate. These application checks incur provider usage; runtime and compiler regressions do not. See [the recorded release evidence](Verification.md).
