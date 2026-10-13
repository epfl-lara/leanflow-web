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

Open `.env` and set `LEMEX_API_KEY` and `LEMEX_BASE_URL` for your provider. You can leave them empty to use the Lean editor without the assistant.

```bash
node --env-file=.env server/studio.mjs
```

Keep this terminal running. To run in the background, use the [service setup](Configuration.md#run-as-a-service).

### 4. Sign in

Open **http://localhost:8090**. In another terminal, from the app directory, read your sign-in token:

```bash
cat .data/auth/owner.token
```

Paste it into the sign-in screen and choose **Import or create project**. Keep the token and `.env` private.

## Open it from another computer

Run this on your own computer, replacing the SSH address:

```bash
ssh -L 8090:127.0.0.1:8090 user@your-server
```

Open **http://localhost:8090** there and sign in with the same token.

For an HTTPS address or additional accounts, see [Configuration](Configuration.md). For proof selection, chats, uploads, and Git, see [Using LeanFlow Web](UsingLeanFlow.md).
