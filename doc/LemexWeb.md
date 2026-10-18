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

Follow [Prepare Lemex](NativeLemex.md) to build the native runtime and Docker worker. Do this once; the initial build can take a while.

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

Open `.env` and set `LEMEX_BASE_URL` to your provider’s HTTPS API endpoint. Each account adds its own API key at first sign-in and can update it in Assistant settings. The web app no longer uses a shared server API key.

```bash
node --env-file=.env server/studio.mjs
```

Keep this terminal running. To run in the background, use the [service setup](Configuration.md#run-as-a-service).

### 4. Sign in

Open **http://localhost:8090**. In another terminal, from the app directory, read your sign-in token:

```bash
cat .data/auth/owner.token
```

Sign in with the token, then save your own Lemex API key. See [accounts and personal keys](Configuration.md#accounts-and-personal-api-keys) for invitations and roles.

After saving your key, choose **Import or create project**. Keep your token, API key, and `.env` private.

## Open it from another computer

Run this on your own computer, replacing the SSH address:

```bash
ssh -L 8090:127.0.0.1:8090 user@your-server
```

Open **http://localhost:8090** there and sign in with the same token.

For an HTTPS address or additional accounts, see [Configuration](Configuration.md). For proof selection, chats, uploads, and Git, see [Using LeanFlow Web](UsingLeanFlow.md).
