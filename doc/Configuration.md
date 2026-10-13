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

## Adjust capacity

Use the `STUDIO_MAX_*` settings in [`.env.example`](../.env.example) to set editor, agent, search, worker, and queue limits. Set `STUDIO_WORKER_CPUS` and `STUDIO_WORKER_MEMORY` for each worker; defaults are 2 CPUs and 4 GiB.

Editors and agents share worker slots with setup and proof checks. Leave spare slots and RAM for those jobs. Apply changes during an idle restart, then check the intended workload and your provider's quotas. A larger server needs its own capacity settings and a load test.

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

Setup runs `lake exe cache get` in a separate workspace and checks `import Mathlib`
with dependencies mounted read-only before making an entry available. Projects
and assistant runs mount the shared packages and downloaded artifacts read-only.
Proof sources, project builds, and new cache artifacts stay private.

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
