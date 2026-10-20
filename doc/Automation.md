# Checks and releases

GitHub Actions runs on GitHub-hosted Linux machines. Checks use isolated fixtures and require no provider keys or deployment credentials.

Before the first run, allow Actions for the repository in its organization settings, then enable it under **Repository settings → Actions → General**. Set the default workflow token to **Read repository contents and packages permissions** and require actions to use full commit hashes. An organization policy can prevent repository administrators from enabling Actions themselves.

| Workflow     | When                                                             | What it checks or produces                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CI**       | Pull requests, pushes to `main`/`dev`, merge queues, or manually | Node.js 24/26 tests, Python packaging, workflow validation, types, lint, changed-file formatting, production dependency audit, client build, and browser regressions.                  |
| **Security** | Pull requests, `main`, merge queues, weekly, or manually         | CodeQL for JavaScript/TypeScript, Python, and workflows; dependency review on pull requests.                                                                                           |
| **Release**  | Manually on `main`, or a `v*` tag                                | Repeats CI, resolves the latest Lemex release, checks real Lean execution and Docker isolation, and packages the app and worker. A version tag also creates an attested draft release. |

Dependabot proposes weekly updates for npm packages, actions, and Docker base images. Review and merge them through the same checks. Worker builds check the bundled LeanProbe pins for the configured presets without querying GitHub, then resolve npm's latest Lemex release and verify its integrity. Release automation additionally checks support for the latest stable Lean; run `node scripts/ci/check-lean-probe-pins.mjs --latest` to opt into that check locally. Each release manifest records the version and provenance from the actual worker image. See [Lemex updates](NativeLemex.md#updates).

Keep the Monaco service packages compatible with `lean4monaco`'s editor wrapper; major and minor service updates need a coordinated editor upgrade. Retain a supported Ubuntu LTS base when reviewing worker updates. The client build also checks Lean's info-panel scripts, styles, and fonts at their expected URLs.

## Run checks locally

Use Linux and Node.js 24 or newer for the full server suite; containment checks require Linux filesystem support. After `CYPRESS_INSTALL_BINARY=0 npm ci`, run `npm test`, `npm run check`, `npm run lint`, `npm audit --omit=dev --audit-level=high`, and `npm run build`. Check workflow syntax with `bash scripts/ci/check-workflows.sh`.

For browser checks on Linux, install Chromium with `npx --no-install playwright install --with-deps chromium`, then run `node scripts/ci/check-browser.mjs`. The runner serves the built client and mocks APIs, Lean, the PDF compiler, and providers. CI runs separate **chat** and **workspace** groups, covering accounts, models, RCP waiting, readable chats, autosave, cache invalidation, files, Git, books, downloads, and PDF workflows. Reports and screenshots are saved under `.runtime/` and uploaded by CI.

To focus a run, append `--group=chat`, `--group=workspace`, or individual suite names such as `rcp-queue autosave lean-cache`. The [installation checks](Verification.md) separately verify real Docker workers, prepared libraries, and the optional PDF compiler.

## Prepare a release

1. Run **Actions → Release → Run workflow** on `main` to prepare a candidate. Download `release-candidate` from the completed run; artifacts are retained for seven days.
2. For a release, update the root `package.json` version and its lockfile, commit to `main`, then push a matching tag such as `v0.1.0`. Tags must point to commits in `main` history.
3. Review the resulting draft on **Releases**, then publish it. The draft includes an app archive with the built client, a Linux x64 Docker worker archive, checksums, a manifest, and the exact npm dependency lockfile.

Only the draft-release job receives release-writing permissions. All external actions are pinned to full commit hashes. Repository administrators can add reviewers to the `release` environment and make **CI passed** a required branch check. Fork pull requests use GitHub-hosted runners with read-only repository access.

## Install a release

Download the release assets into an empty directory. Verify them before extracting:

```sh
sha256sum --check SHA256SUMS
gh attestation verify leanflow-web-*.tar.gz --repo epfl-lara/leanflow-web
gh attestation verify leanflow-worker-*.tar.gz --repo epfl-lara/leanflow-web
tar -xzf leanflow-web-*.tar.gz
docker load --input leanflow-worker-*.tar.gz
cd leanflow-web
CYPRESS_INSTALL_BINARY=0 npm ci --omit=dev
```

Continue from [Choose where to store data](LemexWeb.md#2-choose-where-to-store-data). Set `LEMEX_WORKER_IMAGE` in `.env` to the image recorded in `release-manifest.json`. The client and Lean worker are already built; prepare the libraries and start the app. For PDF compilation, also build the [optional TeX worker](Configuration.md#latex-compilation). ARM64 hosts can use the [source installation](LemexWeb.md#install-and-run).

For an existing installation, keep its private data and settings, take a consistent [backup](Configuration.md#back-up-before-upgrading), and switch releases after active work finishes. Worker changes invalidate shared caches, so allow time and space for preparation. See [Hosting](Hosting.md) for the service and HTTPS setup.

Release workflows prepare downloadable artifacts. Apply server upgrades during a planned maintenance window after reviewing the release and its configuration.
