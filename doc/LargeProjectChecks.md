# Check a large imported project

Run the pinned [ten-proofs](https://github.com/openai/ten-proofs/tree/94bc0feb6a9ff12c7d31d6de640a725c9d43d2b6) setup check from the repository root:

```sh
npm ci
node scripts/check-ten-proofs-setup.mjs --image lemex-web-worker:local
```

Use Node 24 or newer, Git, Docker and a prepared [LeanFlow worker image](NativeLemex.md). Public internet access is required for the repository, Lean toolchain and dependency caches. Allow substantial disk space and time for two complete builds.

The check creates its own data directory under `.runtime/`. It imports a cold project and a warm project through the normal workspace setup, with automatic agent repair disabled. It checks all pinned source files, all ten theorem files through the file API, exact dependency revisions, read-only shared dependencies, cache reuse, `lake build All`, `import All` and snapshot imports. It leaves a JSON report and command logs in its directory. Interrupting it stops only its own helper workers.

The fixture pins Lean **4.32.0**, mathlib **81a5d257c8e410db227a6665ed08f64fea08e997** and Comparator **07bc4ea40f2266dcb861820a2ec1fa3244ed307f**. These builds check elaboration. They do not run Comparator's independent comparison, Landrun, lean4export or nanoda.

The default is one worker with **6 CPUs and 24 GiB**. The `MetricCodes` compiler was observed at about **14 GiB RSS**, so small worker limits can fail this fixture. This is one observation, not a measured peak or minimum requirement. These are check settings; they do not change the application's capacity configuration. `LEAN_NUM_THREADS=1` limits Lake scheduling and is not a strict process cap or a thread limit for compiler subprocesses.

```sh
node scripts/check-ten-proofs-setup.mjs \
  --image your-worker:tag --cpus 6 --memory 24g \
  --timeout-minutes 240 \
  --build-timeout-minutes 90 --import-timeout-minutes 10
```

If repeated public Git downloads are unreliable, `--dependency-sources /path/to/public-sources` accepts an optional directory containing exactly the manifest's package names. Each must be a clean checkout of its pinned revision with its public GitHub origin. The check rejects build artifacts, private files and links outside the public source checkout. It creates fresh Git metadata and copies no source checkout configuration or hooks. The report records that source assistance was requested and whether it was used; compiled artifacts are never seeded. This assisted run is a separate result from an unassisted import.

Run the small fixture tests without Docker or providers:

```sh
node --test scripts/ten-proofs-fixture.test.mjs
```
