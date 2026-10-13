# Prepare Lemex

Run these commands from your LeanFlow Web checkout. The app checks a specific native Lemex revision; an npm launcher alone is insufficient.

## Build the native runtime

Install the [Lemex build prerequisites](https://github.com/Lemmy00/lemex/blob/2f0e12c10d0baf7404a83da3b8cb8f04b77822c9/docs/install.md#requirements) first. On Debian/Ubuntu, this includes `build-essential`, `pkg-config`, `libssl-dev`, and `libcap-dev`; you also need curl and ripgrep. The installer supplies Rust if needed.

```bash
mkdir -p .runtime
git clone https://github.com/Lemmy00/lemex.git .runtime/lemex-source
git -C .runtime/lemex-source checkout 2f0e12c10d0baf7404a83da3b8cb8f04b77822c9
CARGO_TARGET_DIR="$PWD/.runtime/lemex-build" \
  LEMEX_INSTALL_PREFIX="$PWD/.runtime/lemex-install" \
  LEMEX_BUILD=release \
  bash .runtime/lemex-source/scripts/install/install_from_source.sh
```

This keeps the build artifacts needed for verification. It creates `~/.lemex/config.toml` and `models.json` if they do not exist; existing configuration is kept.

## Build the Docker worker

```bash
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
lemex_target="$(rustc -vV | sed -n 's/^host: //p')"
npm run worker:build -- \
  --source ".runtime/lemex-install/lib/node_modules/lemex/vendor/$lemex_target" \
  --config "$HOME/.lemex/config.toml" \
  --source-checkout .runtime/lemex-source \
  --build-artifacts .runtime/lemex-build/release
```

If you use a custom `LEMEX_HOME`, use its `config.toml` above and set `LEMEX_HOME` in the app's `.env` too.

The worker includes Lean, LeanProbe, LeanExplore, and the Lean language-server tools. Return to [Install and run](LemexWeb.md#install-and-run) to prepare project libraries and start the app.

## Already have a verified native installation?

Use its runtime directory and configuration:

```bash
npm run worker:build -- --source /path/to/native/lemex --config /path/to/config.toml
```

The installation must match the revision above. If it has no `lemex-install.json`, also supply its clean `--source-checkout` and matching `--build-artifacts` directory. Use `python3 scripts/package-lemex.py --help` for the available options.
