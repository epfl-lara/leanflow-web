# Lemex Web

A self-hosted Lean workspace for the machine owner and trusted collaborators. Import a Git project from the sidebar, open its Lean files with live goals and diagnostics, and ask Lemex to find, repair, or optimize proofs, formalize mathematics, and search for declarations.

The server uses the latest verified native Lemex revision, `2f0e12c10d0baf7404a83da3b8cb8f04b77822c9`. It keeps its own state and leaves the user's installed Lemex configuration and conversation history untouched.

Features:

- Persistent projects, GitHub repository or subfolder links, local file/folder uploads, file creation/editing, branches, reviewed commits, and explicit pushes using a one-use repository token. Failed import setup can trigger an announced, isolated Lemex repair followed by environment checks.
- Monaco editor, Lean infoview, live diagnostics, checks of the selected file, resizable panels, and readable light/dark goals.
- Prebuilt Mathlib, CSLib, and Physlib environments with compatible pinned dependencies. Select Mathlib together with CSLib or Physlib; incompatible prepared versions are explained. Lean basics can use another exact Lean release; imported repositories use their own toolchain.
- Four assistant sections: **Proofs** (repair/find), **Formalize**, **Optimize**, and **Search**, with model selection, progress streaming, cancellation, and saved runs.
- Continuous project chats with New chat, a chat selector, per-chat drafts, and up to 12 context files selected from the picker or with `@`. Send updates during a run, expand inline reasoning, or Stop and continue. Each run starts a fresh native worker and receives only the selected chat's bounded server-owned conversation context.
- Saved agent edits appear live in the editor by default, with independent final verification and Undo. Disable **Edit files live** for a separate candidate and explicit diff review/Apply.
- Completed replies render Markdown tables, lists, links, and Lean code; wide tables scroll within the chat.
- Runs continue until completion or Stop, with no time-limit control. Options expose the reasoning efforts supported by the selected Lemex model. Reasoning and readable usage totals show only data actually emitted by the runtime.
- Recoverable deletion of files, folders, projects, and chats, with Undo and a Trash restore view.
- Fresh verification workspaces, kernel replay, axiom inspection, and proof-body restrictions. Review-first acceptance checks the full saved baseline; live edits protect touched files and project configuration while preserving unrelated edits.
- LeanProbe for iterative proof checks, configurable assistant instructions and tools, Loogle search, and extensible server-side MCP configuration.
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

Choose an assistant section, start or select a chat, and use **Select files** to attach saved project or read-only library context. **Optimize** preserves existing theorem statements and compares proof-body tokens and genuine synchronous Lean heartbeats under the project's exact toolchain. Shorter proofs can cost more heartbeats; the interface keeps both results visible. These are local measurements, not official competition scores or cross-version compatibility results.

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
node scripts/check-optimization.mjs
```

`node scripts/check-application.mjs` makes a real provider request, repairs a broken proof in a new test project, verifies and applies the result, and checks it again. `node scripts/check-browser.mjs` checks live diagnostics and the desktop/mobile interface in a separate project. `node scripts/check-optimization.mjs` uses compiler-only fixtures with no model or worker network to check measurements in the installed Lean and Mathlib presets. See [verification evidence](doc/Verification.md) for completed checks, the measured token/heartbeat tradeoff, and Claude Code reviews.

Read [deployment and configuration](doc/LemexWeb.md) for account management, systemd, HTTPS, native-runtime updates, dependency caches, and backups. Private-repository imports, shared-project ACLs, and real-time coediting are future extensions; current imports use public HTTPS repositories. Publishing accepts an HTTPS repository destination and a token entered for that push.

Hosted LeanExplore is configured, but its upstream service currently returns HTTP 403 to requests from larapc2. Loogle and the local Lean tools work; search failures are surfaced in the interface.

## Upstream

Built from [lean4web](https://github.com/leanprover-community/lean4web), using [lean4monaco](https://github.com/hhu-adam/lean4monaco), the Lean infoview, and [Lemex](https://github.com/Lemmy00/lemex). Original upstream files remain for provenance; the application entry points are `server/studio.mjs` and `client/src/studio/Studio.tsx`. Apache-2.0 licensing and existing notices are preserved.
