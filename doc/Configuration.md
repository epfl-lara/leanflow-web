# Configure LeanFlow Web

Start with the [installation guide](LemexWeb.md#install-and-run). Put settings in your private `.env`, then run `node --env-file=.env server/studio.mjs`. Changes take effect after a restart.

## Provider and server settings

Set `LEMEX_API_KEY` and `LEMEX_BASE_URL` for your Lemex provider to enable the assistant. Leave them empty to use the editor without inference. Assistant requests use your provider's billing.

| Setting                           | Use                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `LEMEX_API_KEY`, `LEMEX_BASE_URL` | Provider credentials and API endpoint.                                                                 |
| `LEMEX_HOME`                      | Override the packaged Lemex config and model catalog; falls back to `~/.lemex` when no package exists. |
| `STUDIO_MODEL`                    | Override the default model, `deepseek-ai/DeepSeek-V4.1-Flash`.                                         |
| `HOST`, `PORT`                    | Listen address and port; defaults to `127.0.0.1:8090`.                                                 |
| `STUDIO_DATA_DIR`                 | Accounts, projects, chats, and caches; defaults to `.data`.                                            |
| `STUDIO_ORIGIN`                   | Exact public HTTPS origin, including a nonstandard port if used.                                       |
| `STUDIO_MAX_WORKERS`              | Maximum active workers; defaults to `6`.                                                               |
| `LEMEX_WORKER_IMAGE`              | Worker image; defaults to `lemex-web-worker:local`.                                                    |

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

Use the `STUDIO_MAX_*` settings in [`.env.example`](../.env.example) to set editor, agent, search, worker, and queue limits. Set `STUDIO_WORKER_CPUS` and `STUDIO_WORKER_MEMORY` for each worker; defaults are 2 CPUs and 4 GiB.

Editors, terminals, and agents share worker slots with setup and proof checks. `STUDIO_MAX_TERMINALS` defaults to 2 across the server; `STUDIO_MAX_TERMINALS_PER_PROJECT` defaults to 1. Each terminal uses the worker CPU, RAM, and process limits. Leave spare slots and RAM for interactive work and checks. Apply changes during an idle restart, then check the intended workload and your provider's quotas. A larger server needs its own capacity settings and a load test.

The default limits allow 4 editors, 2 terminals, and 2 agents to share 6 worker slots. These individual limits do not reserve workers. Lower their limits or increase `STUDIO_MAX_WORKERS` with enough CPU and RAM to leave room for checks and setup.

Project setup allows 30 minutes for its own Lake build. Large imported repositories can need longer. Set a bounded timeout in the private environment file, for example 90 minutes:

```dotenv
STUDIO_SETUP_BUILD_TIMEOUT_MS=5400000
```

Lean checks use the setup build timeout by default. Set `STUDIO_CHECK_TIMEOUT_MS` to override it. Specialized Lemex setup repair has a separate 15-minute deadline, including queue time. Set `STUDIO_SETUP_REPAIR_TIMEOUT_MS` to adjust it. These deadlines are bounded to six hours, and Stop remains available while work is queued or running.

The maximum is 6 hours. Editors, assistant runs and proof verification use their own limits. Longer builds also need enough worker RAM; measure representative repositories and leave headroom for every worker that can run together. Review `STUDIO_MAX_WORKERS`, `STUDIO_WORKER_CPUS` and `STUDIO_WORKER_MEMORY` together before an idle restart.

Bulk source uploads and saves share `STUDIO_MAX_SOURCE_REQUESTS` slots (default 2, at most 1 per account by default). Known uncompressed requests up to 3 MiB have a separate bounded lane: `STUDIO_MAX_SMALL_SOURCE_REQUESTS` defaults to 8, with at most 2 per account. This keeps ordinary saves available while large uploads run. Compressed and unknown-length requests use bulk capacity. Both lanes include body parsing and queued writes, even after a parsed request disconnects. Keep bulk capacity low when worker memory is tight. A busy request returns a retryable message and preserves the editor's unsaved buffer.

With the default configuration, the assistant opens with DeepSeek-V4.1-Flash at `max`, its highest supported reasoning effort. Model and effort changes apply while the assistant is open; reopening it restores the default. The server offers each model's supported levels and disables the effort selector for models without adjustable effort. The UI and isolated Lemex workers use the same corrected catalog.

## Add a collaborator

Run from the checkout, using the same environment file as the server:

```bash
node --env-file=.env scripts/add-user.mjs "Collaborator name"
```

Share the printed token privately. Each account has its own projects and chats. For the service below, use `--env-file=.data/server.env` instead.

## Run as a service

The [systemd example](../deploy/leanflow-web.service) assumes a checkout at `~/leanflow-web`. Adjust its paths and Node 24+ `PATH` for your installation. Stop any existing foreground server first.

```bash
mkdir -p .data ~/.config/systemd/user
cp .env .data/server.env
chmod 600 .data/server.env
cp deploy/leanflow-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now leanflow-web.service
```

Check status with `systemctl --user status leanflow-web.service`; read logs with `journalctl --user -u leanflow-web.service`. Ask the host administrator to enable user lingering if it must survive logout.

## Use an HTTPS address

Keep the app on `127.0.0.1:8090` and put a reverse proxy in front of it. Use the [Caddyfile](../deploy/Caddyfile.example) with your existing proxy, or prepare the supplied [Docker proxy service](../deploy/leanflow-proxy.service):

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

Replace `lean.example.org` in the private Caddyfile with your hostname. Point its DNS at the server and allow TCP 80/443 through the intended network. Automatic certificates require reachable challenge ports; see [Caddy's HTTPS setup](https://caddyserver.com/docs/automatic-https). With an existing certificate, put its chain and key in the private `certs` directory and enable the example `tls` line.

Set `STUDIO_ORIGIN=https://your-hostname` in `.data/server.env`. Wait for proof runs and project setup to finish, then:

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

## Keep data and credentials private

Back up your data directory (`.data` by default) while the server is stopped or from a consistent snapshot. It contains project sources, account tokens, saved provider settings, and chats. Dependency caches take several gigabytes; keep them while projects or runs use them.

Never commit `.env`, `.data`, tokens, or certificate keys. Use trusted collaborators and repositories: imported project code and assistant tools can access the assistant worker's provider key. Read [SECURITY.md](../SECURITY.md) before exposing the server to additional users.
