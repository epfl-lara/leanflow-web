# Prepare Lemex

Run these commands from your LeanFlow Web checkout. The app checks a specific native Lemex revision; an npm launcher alone is insufficient.

## Build the native runtime

Install the [Lemex build prerequisites](https://github.com/Lemmy00/lemex/blob/787a20eec6b6c50747e9040dc82f272ef16b80a6/docs/install.md#requirements) first. On Debian/Ubuntu, this includes `build-essential`, `pkg-config`, `libssl-dev`, and `libcap-dev`; you also need curl and ripgrep. The installer supplies Rust if needed.

```bash
mkdir -p .runtime
git clone https://github.com/Lemmy00/lemex.git .runtime/lemex-source
git -C .runtime/lemex-source checkout 787a20eec6b6c50747e9040dc82f272ef16b80a6
CARGO_TARGET_DIR="$PWD/.runtime/lemex-build" \
  LEMEX_INSTALL_PREFIX="$PWD/.runtime/lemex-install" \
  LEMEX_HOME="$PWD/.runtime/lemex-install-config" \
  LEMEX_BUILD=release \
  bash .runtime/lemex-source/scripts/install/install_from_source.sh
```

This keeps the build artifacts needed for verification. It installs bundled defaults in `.runtime/lemex-install-config` without importing personal keys or sessions. The packager verifies the exact commit and installed binary hashes. After packaging succeeds, the compiler cache can be removed.

## Build the Docker worker

```bash
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
lemex_target="$(rustc -vV | sed -n 's/^host: //p')"
npm run worker:build -- \
  --source ".runtime/lemex-install/lib/node_modules/lemex/vendor/$lemex_target" \
  --config .runtime/lemex-install-config/config.toml \
  --source-checkout .runtime/lemex-source \
  --build-artifacts .runtime/lemex-build/release
```

The app normally reads its sanitized `.runtime/lemex` bundle. Use a separate `LEMEX_HOME` override only when that directory contains the same verified native binary and catalog; a personal config directory alone does not supply the binary needed for model discovery.

The worker includes Lean, LeanProbe, LeanExplore, and the Lean language-server tools. Return to [Install and run](LemexWeb.md#install-and-run) to prepare project libraries and start the app.

## Already have a verified native installation?

Use its runtime directory and configuration:

```bash
npm run worker:build -- --source /path/to/native/lemex --config /path/to/config.toml
```

The installation must match the revision above. If it has no `lemex-install.json`, also supply its clean `--source-checkout` and matching `--build-artifacts` directory. Use `python3 scripts/package-lemex.py --help` for the available options.
