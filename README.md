<p align="center"><img src="client/public/leanflow-mark.svg" width="80" height="80" alt="LeanFlow Web logo"></p>

# LeanFlow Web

A self-hosted Lean workspace with a Lemex proof assistant. Import a project, explore its files with live goals and diagnostics, and work on proofs, formalization, optimization, and declaration search in one place.

Developed by [EPFL LARA](https://lara.epfl.ch/).

## Features

- **Projects:** public Git repositories and GitHub subfolder links, local file/folder uploads, pinned Lean versions, and prepared Mathlib, CSLib, and Physlib environments. Compatible libraries can be combined when creating a project.
- **Lean editor:** Monaco, the Lean infoview, live diagnostics, resizable panels, and light/dark themes.
- **Assistant:** Proofs, Formalize, Optimize, and Search; model and reasoning-effort selection; readable streaming conversations; updates and cancellation during a run; saved chats with automatic or manual names; and `@` file references.
- **Live edits:** see saved agent changes in your project while Lemex works, with independent verification and guarded Undo. A separate candidate/review/Apply workflow is also available.
- **Tools:** LeanProbe, Lean LSP tools, LeanExplore semantic search by default, Loogle type-pattern search, and configurable MCP servers.
- **Source control:** review changes, create branches and commits, and explicitly push with a one-use repository token kept separate from the proof agent.
- **Recovery:** recoverable file, folder, project, and chat deletion; announced setup repair in a disposable workspace when an import needs help.

Workers are contained in Docker, and accounts own separate projects. The deployment model is **a machine owner and trusted collaborators using trusted repositories**. This is not an anonymous code-execution service. See [worker isolation and limits](doc/LemexWeb.md#worker-isolation-and-limits) for the precise boundary.

## Install

Requirements: Linux, Node.js 24 or newer, Python 3.11 or newer, Git, Docker Engine accessible to the server account, and a verified **native** Lemex installation with its model catalog. Dependency caches require several gigabytes of disk space.

This release packages Lemex revision `2f0e12c10d0baf7404a83da3b8cb8f04b77822c9`. Install/build that native revision using the [Lemex project](https://github.com/Lemmy00/lemex), then supply the native installation and configuration paths below. An npm launcher alone is insufficient. See [native runtime packaging](doc/LemexWeb.md#native-lemex-and-tools) for provenance requirements and installations without metadata.

```bash
git clone https://github.com/epfl-lara/lemex-web.git
cd lemex-web
CYPRESS_INSTALL_BINARY=0 npm ci

# Replace these with your native Lemex installation and config paths.
npm run worker:build -- \
  --source /path/to/native/lemex \
  --config /path/to/lemex/config.toml

npm run presets:install
npm run build
cp .env.example .env
chmod 600 .env
```

Edit `.env` to set `LEMEX_API_KEY` and `LEMEX_BASE_URL` for your Lemex RCP provider, and optionally choose `STUDIO_MODEL`. If the installed configuration/catalog is outside `~/.lemex`, also set `LEMEX_HOME` to the directory containing `config.toml` and its referenced model catalog; the worker build's `--config` option does not set this server variable. Start the server with explicit environment-file loading:

```bash
node --env-file=.env server/studio.mjs
```

Open **http://localhost:8090**. In another terminal in the checkout, run `node --env-file=.env scripts/access.mjs` to display the owner sign-in token using the same configuration. With the default data directory, `npm run access` also works. For a remote host, use an SSH tunnel such as `ssh -L 8090:127.0.0.1:8090 user@your-server` and open the same local address.

`.env` is **not loaded automatically** by `npm start` or `npm run dev`; those commands use the exported process environment. A systemd example with an explicit environment file is included in [deployment and configuration](doc/LemexWeb.md).

Keep `.env`, `.data`, `.runtime`, tokens, provider keys, project contents, and run logs private. These paths are excluded from Git. Provider credentials are retained in the application's private data directory; publishing this source repository does not publish a running instance or its projects.

## Development and checks

`npm run dev` serves the client on port 3000 and the backend on port 8090. Export the desired configuration first. Production serves the built client and API together on port 8090.

The ordinary checks need no model credentials, worker image, or prepared Lean caches:

```bash
npm test
npm run check
npm run lint
npm run build
```

After preparing the Docker runtime and presets, `node scripts/check-runtime.mjs`, `node scripts/check-verification.mjs`, and `node scripts/check-optimization.mjs` exercise real Lean execution and verification. `node scripts/check-application.mjs` additionally makes a real provider request and incurs provider usage. Browser checks require Playwright Chromium. See [deployment and configuration](doc/LemexWeb.md#verification) and [recorded verification evidence](doc/Verification.md) for scope and limitations.

## Credits and license

Built from [lean4web](https://github.com/leanprover-community/lean4web), using [lean4monaco](https://github.com/hhu-adam/lean4monaco), the Lean infoview, [Lemex](https://github.com/Lemmy00/lemex), and [LeanProbe](https://github.com/epfl-lara/LeanProbe). Original upstream files and notices are retained. The application entry points are `server/studio.mjs` and `client/src/studio/Studio.tsx`.

Licensed under [Apache-2.0](LICENSE); existing third-party license notices continue to apply. LeanFlow Web uses its own product mark; the EPFL LARA attribution identifies its developers.
