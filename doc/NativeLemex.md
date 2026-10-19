# Prepare Lemex

From the LeanFlow Web checkout:

    npm run worker:build

Every build resolves **@lemmy00/lemex@latest** from npm for the Linux Docker host
(x64 or ARM64). It verifies the published SHA-512 integrity, native package
version, and architecture before replacing the runtime. A failed download or
verification leaves the previous bundle in place; it does not fall back to an
older release. Rust and a Lemex source checkout are unnecessary.

The generated `.runtime/lemex/manifest.json` records the exact resolved version,
integrity, and file hashes. The bundle supplies both the worker and account model
discovery. Only release assets and the web app's RCP defaults are included.
Host credentials, personal configuration, sessions, and hooks are never copied.
Each web account enters its own provider key after signing in.

The worker also includes Lean, LeanProbe, LeanExplore, and the Lean language
server tools. Its first Docker build can take several minutes.

## Optional terminal installation

To use Lemex separately in a terminal:

    npm install -g @lemmy00/lemex@latest
    lemex setup

This is independent of web accounts. The web worker needs no host login or setup.

## Updates

Rebuild the worker to install the latest published release. No source edit is
needed when Lemex releases a new version:

    LEMEX_WORKER_IMAGE=lemex-web-worker:your-release npm run worker:build

Test the new image, then set LEMEX_WORKER_IMAGE to that tag in the server's private
environment file. Restart while no proof, setup, check, or agent jobs are active.
Rebuild project environments with Refresh setup when the new worker image requires
cache revalidation. Existing account keys, settings, projects, and toolchain pins
are retained. Keep the previous image for rollback.

Running workers keep their installed version until rebuilt and restarted.
Downloaded LeanFlow release archives likewise retain the exact worker recorded
in their release manifest; rebuild to move them to the newest Lemex release.

For an explicit reference build, `npm run worker:build -- --pinned` uses
[deploy/lemex-runtime.json](../deploy/lemex-runtime.json). An already installed
native vendor directory at that reference version can also be packaged using
`--source /path/to/vendor/linux-target`. This offline option checks its native
layout, version and architecture and records local file hashes; it does not claim
npm tarball integrity for those local bytes.

Return to [Install and run](LemexWeb.md#install-and-run).
