# Install LeanFlow Web

You need Linux, Node.js 24+, Python 3.11+, Git, and Docker running with access for your user. Allow several gigabytes for Lean libraries.

## Install and run

### 1. Get the app

```bash
git clone https://github.com/epfl-lara/leanflow-web.git
cd leanflow-web
CYPRESS_INSTALL_BINARY=0 npm ci
```

### 2. Prepare the worker

Build the worker. This downloads the pinned precompiled `@lemmy00/lemex` npm release, verifies its integrity, and includes the Lean tools. You do not need to compile Lemex or configure a host API key:

```bash
npm run worker:build
```

See [Prepare Lemex](NativeLemex.md) for release details and updates. The first Docker build also installs the Lean tools and can take a while.

Then prepare a basic Lean project and build the app:

```bash
npm run presets:install -- lean
npm run build
```

To also prepare Mathlib, CSLib, and Physlib, run `npm run presets:install`. Their dependency downloads take more time and disk space.

### 3. Configure and start

```bash
cp .env.example .env
chmod 600 .env
```

RCP is ready as the default provider; leave `LEMEX_BASE_URL` unset. Each account adds its own API key at first sign-in and can update it in Assistant settings. Users who want another Responses-compatible provider can select **Another provider** and enter its public HTTPS API base URL and key there. The web app does not use a shared server API key.

```bash
node --env-file=.env server/studio.mjs
```

Keep this terminal running. To run in the background, use the [service setup](Configuration.md#run-as-a-service).

### 4. Sign in

Open **http://localhost:8090**. In another terminal, from the app directory, read your sign-in token:

```bash
cat .data/auth/owner.token
```

Sign in with the token, then save your own Lemex API key. LeanFlow discovers the models that key can use; refresh its access in Assistant settings after permissions change. See [accounts and personal keys](Configuration.md#accounts-and-personal-api-keys) for invitations and roles.

After saving your key, choose **Import or create project**. Keep your token, API key, and `.env` private.

## Open it from another computer

Run this on your own computer, replacing the SSH address:

```bash
ssh -L 8090:127.0.0.1:8090 user@your-server
```

Open **http://localhost:8090** there and sign in with the same token.

For an HTTPS address or additional accounts, see [Configuration](Configuration.md). For proof selection, chats, uploads, and Git, see [Using LeanFlow Web](UsingLeanFlow.md).
