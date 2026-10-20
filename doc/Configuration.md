# Configure LeanFlow Web

Start with the [installation guide](LemexWeb.md#install-and-run). Put settings in your private `.env`, then run `node --env-file=.env server/studio.mjs`. Changes take effect after a restart.

## Provider and server settings

RCP (`https://inference.rcp.epfl.ch/v1`) is the default; no endpoint setting is needed. Each account supplies its own API key during first sign-in. In **Assistant settings → Provider**, users can keep **EPFL RCP (default)** or choose **Another provider** and enter a public HTTPS API base URL and that provider's key. Other providers must support the Responses API and authenticated model listing; Chat Completions-only inference is not supported. Assistant runs, automatic setup repairs, and chat titles use the selected account connection. A newly saved provider applies to new requests; already running requests keep their connection. Queued runs fail if their provider changes before execution. The web app does not use a shared `LEMEX_API_KEY`.

Keys and their endpoints are encrypted together. Updating a connection requires entering its key; changing the URL never forwards an existing key to a new host. Existing RCP keys remain valid without a migration or re-entry. Saved model shortlists are kept separately for each provider endpoint, so switching back to RCP restores its list. `LEMEX_BASE_URL` remains available as an operator override for the default endpoint in existing installations.

To support free RCP keys, requests using the same RCP endpoint and key are scheduled one at a time. Waiting chats and setup repairs remain cancellable, and chat naming waits behind foreground work. Different keys and custom providers keep their own capacity. This coordination applies within one LeanFlow server; other applications using the same key can still cause a provider limit. The app does not infer a subscription tier from the key or silently change the selected model.

Automatic RCP chat naming starts after the first run finishes and its worker releases the key; it occupies no naming slot while that run is active. A cancelled run keeps its prompt-based title. Once requested, naming waits up to 15 seconds for a key or naming slot, then offers manual naming or a later retry. Provider requests have a 30-second timeout, with a 45-second limit for the complete naming job. At most three names per account and 18 server-wide may be pending; actual naming calls remain limited to two. Closing a suggestion cancels its request when no other viewer or automatic naming task needs it. Automatic naming failures keep the existing prompt-based title; a manual name always wins.

| Setting              | Use                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `LEMEX_BASE_URL`     | HTTPS provider endpoint; keys are supplied by each account.                                            |
| `LEMEX_HOME`         | Override the packaged Lemex config and model catalog; falls back to `~/.lemex` when no package exists. |
| `STUDIO_MODEL`       | Override the default model, `deepseek-ai/DeepSeek-V4.1-Flash-1017`.                                    |
| `HOST`, `PORT`       | Listen address and port; defaults to `127.0.0.1:8090`.                                                 |
| `STUDIO_DATA_DIR`    | Accounts, projects, chats, and caches; defaults to `.data`.                                            |
| `STUDIO_ORIGIN`      | Exact public HTTPS origin, including a nonstandard port if used.                                       |
| `STUDIO_MAX_WORKERS` | Maximum active workers; defaults to `6`.                                                               |
| `LEMEX_WORKER_IMAGE` | Worker image; defaults to `lemex-web-worker:local`.                                                    |

See [`.env.example`](../.env.example) for a ready-to-edit file. `npm start` and `npm run dev` do not load `.env` automatically. Exported environment variables override values loaded with Node's `--env-file`.

## Back up before upgrading

The activity database now stores proof changes separately from run metadata. Before upgrading, make a consistent SQLite backup of the configured data directory. SQLite's backup command works while the server is running:

```sh
studio_data_dir="${STUDIO_DATA_DIR:-.data}"
mkdir -p .runtime
sqlite3 "$studio_data_dir/activity.sqlite" ".backup '.runtime/activity-before-update.sqlite'"
```

Keep the backup private. Apply a service update during an idle restart. If you roll back to an older release that expects inline proof changes, restore its matching database backup while the service is stopped. An older release cannot read the migrated change rows. Restoring the backup also rolls back activity recorded after it was created.

New shared-cache certificates use separate immutable entries. Existing active projects retain their dependency bindings. Allow disk space for both generations, and remove old entries only after confirming that no project or active worker uses them.

## Search service

The Search panel uses the hosted LeanExplore HTTP API by default. It does not run `lean-explore data fetch`. Opening a result locally reads the project's installed sources; it does not require a local search index.

To use your own compatible search service, set `STUDIO_LEANEXPLORE_URL` to its full HTTP search endpoint. The service must accept `GET` requests with `q` and `limit` parameters and return LeanExplore v2 JSON results. The configured endpoint is used by the Search panel; assistant MCP tools keep their own configuration.

LeanExplore's local backend requires `lean-explore[local]`, `lean-explore data fetch`, and embedding/reranker models. Its `lean-explore mcp serve --backend local` command provides MCP, which is a different protocol from the Search panel's HTTP API. Provide an HTTP adapter for that backend before configuring this setting. See [LeanExplore's local backend guide](https://github.com/justincasher/lean-explore/blob/main/docs/local-backend.md).

## Adjust capacity

### LaTeX compilation

Build the optional TeX worker image separately from the Lean worker:

```bash
bash scripts/build-tex-worker.sh
```

The default image name is `leanflow-tex:local`. To use another name, set `STUDIO_TEX_IMAGE` when building and in the server environment. The server resolves that tag to an immutable image ID before compiling. A missing TeX image leaves Lean features available and shows an actionable message in the PDF panel. Build a new image tag for an upgrade and change the server setting during an idle restart.

This worker includes latexmk, pdfLaTeX, BibTeX, common LaTeX/math/TikZ packages, and PDF text extraction. Builds run without networking, provider credentials, Lean dependencies, or a shared home directory. Project recipes are ignored and shell escape is disabled. Only bounded source inputs are copied into a disposable working directory. The compiler writes to temporary memory storage; the server validates bounded artifact transfers before saving PDFs, extracted text, and reports outside project sources. Recent build history and the last successful PDF are retained per project. Permanently deleting a chat also deletes its candidate TeX builds.

TeX shares the normal worker pool and its CPU, RAM, and process limits. A project has at most one build at a time. The two-minute build deadline includes waiting for capacity. Leave worker headroom for interactive editing and agents: a compiling assistant already occupies its own worker. The first version supports pdfLaTeX/BibTeX only; unsupported engines are reported instead of silently substituted.

### Worker capacity

Use the `STUDIO_MAX_*` settings in [`.env.example`](../.env.example) to set editor, agent, search, worker, and queue limits. Set `STUDIO_WORKER_CPUS` and `STUDIO_WORKER_MEMORY` for each worker; defaults are 2 CPUs and 4 GiB.

Editors, terminals, and agents share worker slots with setup and proof checks. `STUDIO_MAX_TERMINALS` defaults to 2 across the server; `STUDIO_MAX_TERMINALS_PER_PROJECT` defaults to 1. Each terminal uses the worker CPU, RAM, and process limits. Leave spare slots and RAM for interactive work and checks. Apply changes during an idle restart, then check the intended workload and your provider's quotas. A larger server needs its own capacity settings and a load test.

The default limits allow 4 editors, 2 terminals, and 2 agents to share 6 worker slots. These individual limits do not reserve workers. Lower their limits or increase `STUDIO_MAX_WORKERS` with enough CPU and RAM to leave room for checks and setup.

Project setup allows 30 minutes for its own Lake build. Large imported repositories can need longer. Set a bounded timeout in the private environment file, for example 90 minutes:

```dotenv
STUDIO_SETUP_BUILD_TIMEOUT_MS=5400000
```

Lean checks use the setup build timeout by default. Set `STUDIO_CHECK_TIMEOUT_MS` to override it. Specialized Lemex setup repair has a separate 15-minute execution deadline, starting after an assistant slot and its RCP key are available; queue time does not consume it. Worker startup and the repair itself share that budget. Set `STUDIO_SETUP_REPAIR_TIMEOUT_MS` to adjust it. These deadlines are bounded to six hours, and Stop remains available while work is queued or running.

The maximum is 6 hours. Editors, assistant runs and proof verification use their own limits. Longer builds also need enough worker RAM; measure representative repositories and leave headroom for every worker that can run together. Review `STUDIO_MAX_WORKERS`, `STUDIO_WORKER_CPUS` and `STUDIO_WORKER_MEMORY` together before an idle restart.

Bulk source uploads and saves share `STUDIO_MAX_SOURCE_REQUESTS` slots (default 2, at most 1 per account by default). Known uncompressed requests up to 3 MiB have a separate bounded lane: `STUDIO_MAX_SMALL_SOURCE_REQUESTS` defaults to 8, with at most 2 per account. This keeps ordinary saves available while large uploads run. Compressed and unknown-length requests use bulk capacity. Both lanes include body parsing and queued writes, even after a parsed request disconnects. Keep bulk capacity low when worker memory is tight. A busy request returns a retryable message and preserves the editor's unsaved buffer.

With the default configuration, the assistant prefers DeepSeek-V4.1-Flash-1017. The web app defaults to `high` reasoning for **Ask & Search** and `max` for **Proofs**, **Formalize**, and **Optimize**, when the selected model advertises that level. Otherwise it uses the model's advertised default; fixed-reasoning models receive no explicit override. Explicit supported choices, including the provider-default option, take precedence and are kept separately for each provider, model and mode while the assistant is open. Its bundled preferred models also include DeepSeek-V4.1-Flash, Qwen3.8-Flash-Next, Qwen3.8-27B, GLM-5.3-Flash, and Leanstral-2603. A model is offered only when the account's key exposes it. If the preferred model is unavailable, the default is the first available model in Lemex's priority order.

The server runs native Lemex discovery in a temporary private home. The authenticated `/models` list supplies model candidates. RCP's deployment metadata supplies its verified reasoning options; other providers use their advertised options, with no RCP assumptions or invented reasoning values. Custom catalogs are fetched through a bounded HTTPS transport that pins public DNS addresses and rejects redirects, then normalized by the installed Lemex runtime through a temporary local catalog server. Catalogs are kept in memory for five minutes and are isolated by account, endpoint and effective key. Changing a provider or key invalidates that account's cached access automatically. Use **Assistant settings → Models available with your key → Refresh models** after provider permissions change. A discovery error does not grant access to the bundled fallback catalog. Listing a model does not guarantee that a provider will permit inference; inference failures are reported without substituting another model or provider.

Model and effort choices apply while the assistant is open. Reopening a project restores its available default. Refreshing access preserves a selected model and effort if both remain available. The same account catalog controls assistant runs, queued run admission, setup repair, and chat titles. The worker receives that catalog and uses the selected model’s context limit. Models without adjustable reasoning have the effort selector disabled.

## Accounts and personal API keys

The initial owner is also an administrator. In **Assistant settings → Accounts**, the owner can create user or admin accounts. Admins can create user accounts. Regular users cannot administer accounts. Share each generated sign-in token privately; the app shows it once. Projects, chats, and provider keys remain account-scoped, including for admins.

At first sign-in, enter your own Lemex API key. The server checks access with a non-inference `/models` request before saving it. Later, use **Assistant settings → Your Lemex API key** to replace it. A failed validation preserves the previous key. Running requests keep their current credential; new requests use the replacement.

Keys are stored as account-bound AES-256-GCM ciphertext in `.data/providers`, with private file permissions. Encryption depends on `.data/auth/session.key`: back up that file together with the data directory. Losing or rotating it requires entering saved provider keys again. APIs return only saved/not-saved status, never the stored key. The server process can decrypt keys to run Lemex; retain the trusted-collaborator deployment model.

For a temporary relay that buffers SSE, set `STUDIO_EVENT_TRANSPORT=poll`. Assistant events and reasoning history then use bounded JSON cursor replay. Ordinary deployments retain SSE by default.

The explicit paid provider smoke scripts require `STUDIO_SMOKE_API_KEY` set to your own key. They seed only an isolated fixture account and do not copy another account’s saved key.

### Create an account from the command line

Run from the checkout, using the same environment file as the server:

```bash
node --env-file=.env scripts/add-user.mjs "Collaborator name" user /private/path/collaborator.token
```

Share the private token file securely. Use `admin` instead of `user` to appoint an administrator from the server. Each account has its own projects and chats. For a service installation, use `--env-file=.data/server.env` instead.

## Run as a service

Follow [Run as a service](Hosting.md#run-as-a-service) for the systemd setup, environment file, and logs.

## Use an HTTPS address

Start with [Hosting](Hosting.md#set-up-a-shared-https-address) for DNS, certificates, and network access. If you need a standalone proxy, the supplied [Caddyfile](../deploy/Caddyfile.example) and [Docker proxy service](../deploy/leanflow-proxy.service) keep the app on `127.0.0.1:8090`.

From the app directory, prepare the proxy:

```bash
proxy_config="$HOME/.config/leanflow-web/proxy"
install -d -m 700 "$proxy_config" "$proxy_config/certs" \
  "$HOME/.local/share/leanflow-web/proxy/data" \
  "$HOME/.local/share/leanflow-web/proxy/config"
cp deploy/Caddyfile.example "$proxy_config/Caddyfile"
docker pull caddy:2
printf 'CADDY_IMAGE=%s\n' "$(docker image inspect --format '{{index .RepoDigests 0}}' caddy:2)" \
  > "$proxy_config/proxy.env"
chmod 600 "$proxy_config/Caddyfile" "$proxy_config/proxy.env"
cp deploy/leanflow-proxy.service ~/.config/systemd/user/
```

Replace `lean.example.org` in the private Caddyfile with your hostname. Point its DNS at the server and allow TCP 80/443 through the intended network. Caddy's default automatic certificate setup requires publicly reachable challenge ports; see [Caddy's HTTPS setup](https://caddyserver.com/docs/automatic-https). With an existing certificate, save its chain as `certs/fullchain.pem` and its private key as `certs/privkey.pem` under the private proxy directory, restrict both files to the service account, and enable the example `tls` line.

Set `STUDIO_ORIGIN=https://lean.example.org` with your hostname in `.data/server.env`. Wait for chats, checks, and project setup to finish, then:

```bash
systemctl --user daemon-reload
systemctl --user restart leanflow-web.service
systemctl --user enable --now leanflow-proxy.service
```

Open the HTTPS address from another computer and check sign-in, editor diagnostics, and live chat. The configured origin becomes the write/sign-in address; the old HTTP tunnel is no longer accepted. Tokens are still required. Check proxy failures with `journalctl --user -u leanflow-proxy.service`.

## Share imported dependencies

Imported and uploaded projects with Mathlib can share dependencies with other
projects in the same account. The cache matches the pinned Lean release, every
Git dependency revision, the worker image, and Lake build settings. TOML project
names and root target names can differ. Executable `lakefile.lean` configurations
must match exactly.

Setup downloads available compiled files in a separate workspace and finishes
the dependency builds while that workspace is writable. It then repeats the
builds and checks library imports with dependencies mounted read-only before
making an entry available. Private dependency setup passes the same build replay
check. Projects and assistant runs mount shared packages and downloaded artifacts
read-only. Proof sources, project builds, and new cache artifacts stay private.

Local dependencies, custom package directories, and configurations that need
other project files keep their private setup path. Failed shared preparation also
falls back to private setup. Changing dependency configuration requires preparing
the project again; existing assistant snapshots retain their original cache.

Every project also passes a separate Lean proof check before it becomes ready.
The check imports its supported libraries without compiling unfinished user proofs.
With automatic repair enabled (the default), an environment failure asks Lemex to
repair an isolated copy, then tests the original project again. Repair preserves
valid Lean and dependency pins and proof sources. A failed recheck leaves the
project unavailable with an error instead of marking it ready.

This applies when preparing projects after starting the updated server. Existing
projects and running workers are not migrated or deleted. Restart only when active
proof runs and setup have finished. Cache entries are retained; do not delete them
while projects or snapshots reference them.

## Local Lean books

Download the three official Lean books once:

```bash
node scripts/install-lean-books.mjs
```

This installs HTML, styles, images, fonts, and chapter text in `.runtime/books`. Browsing and searching use these local files, without fetching the websites or calling a model. Each assistant run receives private chapter-text copies in its isolated worker home.

To use another location, install with `node scripts/install-lean-books.mjs --dir /path/to/lean-books` and set `STUDIO_BOOKS_DIR=/path/to/lean-books` before starting the server. To import existing downloaded HTML, add `--source /path/to/downloads`. That directory must contain `functional-programming`, `theorem-proving`, and `reference` subdirectories, each with its own `index.html` and relative assets. Symlinks are rejected.

Existing installed books are preserved. Install into a new directory for a refreshed snapshot, then change `STUDIO_BOOKS_DIR` when the server can be restarted after active work finishes. The reader reports the book's documented Lean version. It does not change project toolchains. Upstream scripts are disabled in the embedded reader; use the panel's local chapter search.

## Keep data and credentials private

Back up your data directory (`.data` by default) while the server is stopped or from a consistent snapshot. It contains project sources, account tokens, saved provider settings, and chats. Dependency caches take several gigabytes; keep them while projects or runs use them.

Never commit `.env`, `.data`, tokens, or certificate keys. Use trusted collaborators and repositories: imported project code and assistant tools can access the assistant worker's provider key. Read [SECURITY.md](../SECURITY.md) before exposing the server to additional users.
