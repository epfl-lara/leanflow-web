# Install LeanFlow Web

You need Linux, Node.js 24+, Python 3.11+, Git, and Docker running with access for your user. Lean libraries and build caches can use many gigabytes. For a shared server, also read [Hosting](Hosting.md).

## Install and run

### 1. Get the app

```bash
git clone https://github.com/epfl-lara/leanflow-web.git
cd leanflow-web
CYPRESS_INSTALL_BINARY=0 npm ci
```

### 2. Choose where to store data

```bash
cp .env.example .env
chmod 600 .env
```

Accounts, projects, and caches go in `.data` by default. To use a separate volume, set `STUDIO_DATA_DIR` in `.env` to an absolute directory owned by your user **before preparing libraries**. See [storage and capacity](Hosting.md#storage-and-capacity).

RCP is the default provider. Each account adds its own API key at first sign-in and can change its key or provider in Assistant settings. Another provider must support the Responses API and authenticated model listing. No shared server API key is needed.

### 3. Prepare the worker and libraries

Build the worker. Each build downloads the latest precompiled `@lemmy00/lemex` npm release, verifies its integrity, records its exact version, and includes the Lean tools. You do not need to compile Lemex or configure a host API key:

```bash
npm run worker:build
```

See [Prepare Lemex](NativeLemex.md) for release details and updates. The first Docker build also installs the Lean tools and can take a while.

Then build the app:

```bash
npm run build
```

On startup, LeanFlow automatically prepares missing Lean, Mathlib, CSLib, and Physlib presets in the background. The project picker shows their progress; prepared libraries are reused by new projects. Initial downloads can take a while and use many gigabytes.

To prepare everything before starting the app, or retry a failed library:

```bash
node --env-file=.env scripts/bootstrap-presets.mjs
```

Append `mathlib`, `cslib`, or `physlib` to prepare just that library. Set `STUDIO_AUTO_PREPARE_PRESETS=0` in `.env` if you prefer manual provisioning.

New Lean basics projects default to the latest stable official release, discovered at startup with a cached fallback when offline. You can choose another exact release, including release candidates. Library presets and existing projects keep their compatible, pinned versions.

### 4. Start the app

```bash
node --env-file=.env server/studio.mjs
```

Keep this terminal running. For a server that stays available after logout, use the [service setup](Hosting.md#run-as-a-service).

### 5. Sign in

Open **http://localhost:8090**. In another terminal, from the app directory, read your sign-in token:

```bash
cat .data/auth/owner.token
```

If you set `STUDIO_DATA_DIR`, read `auth/owner.token` inside that directory instead.

Sign in with the token, then save your own provider API key. For the default EPFL RCP provider, create or find it in the [RCP key portal](https://portal.rcp.epfl.ch/aiaas/keys) while on EPFL/VPN. LeanFlow discovers the models that key can use; refresh its access in Assistant settings after permissions change. See [accounts and personal keys](Configuration.md#accounts-and-personal-api-keys) for invitations and roles.

After saving your key, choose **Import or create project**. Keep your token, API key, and `.env` private.

To open the app from another computer, follow [Hosting](Hosting.md) for a shared HTTPS address or optional private SSH access. For proof selection, chats, uploads, and Git, see [Using LeanFlow Web](UsingLeanFlow.md).
