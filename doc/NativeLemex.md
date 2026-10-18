# Prepare Lemex

From the LeanFlow Web checkout:

    npm run worker:build

The build downloads the precompiled **@lemmy00/lemex 0.1.0** runtime from npm for
the Linux Docker host (x64 or ARM64). It checks the SHA-512 integrity pinned in
[deploy/lemex-runtime.json](../deploy/lemex-runtime.json), verifies the native
package version and architecture, and packages its CLI, code-mode helper,
ripgrep, and sandbox helper. Rust and a Lemex source checkout are unnecessary.

The generated .runtime/lemex bundle supplies both the worker and account model
discovery. Only release assets and the web app's RCP defaults are included.
Host credentials, personal configuration, sessions, and hooks are never copied.
Each web account enters its own provider key after signing in.

The worker also includes Lean, LeanProbe, LeanExplore, and the Lean language
server tools. Its first Docker build can take several minutes.

## Optional terminal installation

To use Lemex separately in a terminal:

    npm install -g @lemmy00/lemex
    lemex setup

This is independent of web accounts. The web worker needs no host login or setup.

## Updates

The worker uses a pinned release so a new installation is reproducible. To update,
review the published npm version and platform integrity values, update
[the release pin](../deploy/lemex-runtime.json), and build a new image:

    LEMEX_WORKER_IMAGE=lemex-web-worker:your-release npm run worker:build

Test the new image, then set LEMEX_WORKER_IMAGE to that tag in the server's private
environment file. Restart while no proof, setup, check, or agent jobs are active.
Rebuild project environments with Refresh setup when the new worker image requires
cache revalidation. Existing account keys, settings, projects, and toolchain pins
are retained. Keep the previous image for rollback.

An already installed native vendor directory at the pinned npm version can also
be packaged using --source /path/to/vendor/linux-target. This checks its native
layout, version and architecture and records local file hashes; it does not claim
npm tarball integrity for those local bytes.

Return to [Install and run](LemexWeb.md#install-and-run).
