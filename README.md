# Lemex Web

A self-hosted Lean workspace for the machine owner and trusted collaborators. Import a Git project from the sidebar, open its Lean files with live goals and diagnostics, and ask Lemex to repair proofs, search for declarations, or formalize mathematics.

The server uses the latest verified native Lemex revision, `2f0e12c10d0baf7404a83da3b8cb8f04b77822c9`. It keeps its own state and leaves the user's installed Lemex configuration and conversation history untouched.

Features:

- Persistent projects, HTTPS Git imports at a branch or commit, file creation/editing, branches, and explicit commits.
- Monaco editor, Lean infoview, live diagnostics, and checks of the selected file.
- Prebuilt Mathlib, CSLib, and Physlib environments with compatible pinned dependencies. Lean basics can use another exact Lean release; imported repositories use their own toolchain.
- Lemex repair/prove/formalize/search modes, model selection, progress streaming, cancellation, saved runs, and candidate diff review.
- Fresh verification workspaces, kernel replay, axiom inspection, proof-body restrictions, and full-context conflict checks before accepting changes.
- Configurable assistant instructions and tools, Loogle search, and extensible server-side MCP configuration.
- Separate collaborator accounts and isolated Docker workers with resource limits.

## Open the larapc2 installation

The enabled user service listens on `127.0.0.1:8090` and persists across logout. From your own computer:

```bash
ssh -L 8090:127.0.0.1:8090 milikic@larapc2
```

Open **http://localhost:8090**. On larapc2, obtain the owner sign-in token with:

```bash
cd /localhome/milikic/lemex-web
npm run access
```

The owner token is also stored in `.data/auth/owner.token` with mode `0600`. Use **Import or create project** in the left sidebar. Library dependencies are already installed on this machine.

## Install elsewhere

Requirements: a Linux host, Node 24 or newer, Python 3.11 or newer, Docker Engine, Git, and a verified native Lemex installation. Set `LEMEX_API_KEY` and optionally `LEMEX_BASE_URL` in the server environment for the configured RCP provider.

```bash
CYPRESS_INSTALL_BINARY=0 npm ci
npm run worker:build
npm run presets:install
npm run build
npm start
```

For development, `npm run dev` serves the client on port 3000 and the authenticated backend on port 8090. Production serves the built client and API from port 8090.

```bash
npm test
npm run check
node scripts/check-runtime.mjs
node scripts/check-verification.mjs
```

`node scripts/check-application.mjs` makes a real provider request, repairs a broken proof in a new test project, verifies and applies the result, and checks it again. `node scripts/check-browser.mjs` checks live diagnostics and the desktop/mobile interface in a separate project. See [verification evidence](doc/Verification.md) for the release checks and Claude Code reviews.

Read [deployment and configuration](doc/LemexWeb.md) for account management, systemd, HTTPS, native-runtime updates, dependency caches, and backups. Private-repository authentication, Git push, shared-project ACLs, and real-time coediting are future extensions; current imports use public HTTPS repositories.

Hosted LeanExplore is configured, but its upstream service currently returns HTTP 403 to requests from larapc2. Loogle and the local Lean tools work; search failures are surfaced in the interface.

## Upstream

Built from [lean4web](https://github.com/leanprover-community/lean4web), using [lean4monaco](https://github.com/hhu-adam/lean4monaco), the Lean infoview, and [Lemex](https://github.com/Lemmy00/lemex). Original upstream files remain for provenance; the application entry points are `server/studio.mjs` and `client/src/studio/Studio.tsx`. Apache-2.0 licensing and existing notices are preserved.
