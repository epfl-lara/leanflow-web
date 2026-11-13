# Ten users compiling Lean — 2026-11-13

**PASS: 70 of 70 checks completed with exit code 0 across ten distinct ordinary
user accounts.** Ten independent browser sessions also edited and saved their
own Lean files concurrently. No application change or capacity increase was
needed. Persistent project storage on worker PCs remains deferred.

## What was exercised

The live deployment tested was `871f5afa48e4d68f35396320073b2db4355762fe`.
Check submissions began at 18:20:27 UTC; the final browser report was written at
19:00:06 UTC. Revision attribution comes from the operator's deployment record
and service working-directory checks, rather than an application version API.
The deployment
subsequently changed to `1ab0c43f51618817e79a98760f91b2f425a87a5c` at 19:03:17 UTC;
these measurements do not certify that later revision. This commit adds tests
and documentation only and does not require a service restart.

Each of ten temporary users had two private projects:

- A native Lean 4.35.0 project with 400 `Nat.add_assoc` theorems, a unique
  namespace, a locked empty dependency manifest and `Workload` as its default
  library target. This exercises the distributed kernel-check path.
- A Mathlib playground on Lean 4.35.0-rc4, importing `Mathlib` and proving 120
  arithmetic propositions with `norm_num`. This exercises the local playground
  build and selected-file check path.

Toolchains and public dependency environments were already prepared. These are
real generated Lean workloads, not a benchmark of arbitrary research projects
or cold dependency downloads. Checks and editor saves used production
authentication, storage, job scheduling and isolated execution containers.

Browser tests used headless Chromium with ten separate cookie contexts and
real ordinary-user sign-ins. Only AI provider/model metadata was replaced in
the browser, allowing disposable accounts without provider keys past the
provider setup screen. User identity, runtime information, project/file APIs,
WebSockets, editor saves and Lean execution remained real. No agent run or
model inference was requested. Provider onboarding and concurrent AI inference
are outside this test. All temporary accounts had no configured provider.

## Results

Every row submitted ten checks concurrently. The submission spread is the time
between the first and last accepted response, not compiler execution time.
Browser round time also includes opening the selected files and checking that
the UI receives completion. API rounds include polling and receipt validation.

| Interface                        | Workload             | Passed | Submission spread | Whole round |
| -------------------------------- | -------------------- | -----: | ----------------: | ----------: |
| API                              | 10 native projects   |  10/10 |             49 ms |    56.231 s |
| API                              | 10 Mathlib files     |  10/10 |             55 ms |    85.899 s |
| API                              | 5 native + 5 Mathlib |  10/10 |             49 ms |    24.406 s |
| Browser                          | 10 native projects   |  10/10 |            245 ms |    55.337 s |
| Browser                          | 5 native + 5 Mathlib |  10/10 |            144 ms |    33.473 s |
| Published API script recheck     | 5 native + 5 Mathlib |  10/10 |             52 ms |    23.382 s |
| Published browser script recheck | 5 native + 5 Mathlib |  10/10 |            138 ms |    30.299 s |

An additional read-only audit joined the 70 recorded job IDs against the
activity database and cluster attempts before fixture deletion. Its private
`audit-summary.json` records the placement totals below; API reports contain
per-round receipts and samples, and browser reports contain UI results and
request latencies. Auxiliary resource captures supply browser worker occupancy
and cgroup measurements. Placement is not inferred from `checkMethod` alone.

The server's activity database independently confirmed 70 distinct completed
jobs with exit code 0, owned by ten distinct accounts. Cluster receipts confirm
40 completed `check.kernel` attempts on **larapc06**. The other 30 were local
Mathlib playground checks. Native source input digests were distinct between
users in each API round. Browser tests returned 404 when a user requested
another user's file or job. All ten users saved fresh, distinct editor markers,
all check buttons returned to their idle state, and no uncaught browser page
errors or editor failure panels were observed.

Authenticated project-list probes stayed responsive during browser compilation:
1,290 probes in the first browser run had p50 **23 ms**, p95 **102 ms**, max
**179 ms**; the 430 recheck probes had p50 **21 ms**, p95 **48 ms**, max **122 ms**.
These are observed request latencies from the test client, not a general SLA.

## Concurrency and resource interpretation

Ten users can have checks outstanding together; this does not mean ten
compilers execute at once. The scheduler intentionally queues excess work:

- The VM had seven total worker slots, an interactive limit of four, a batch
  limit of six, one reserved interactive slot and three reserved batch slots.
  Sampling observed six active local batch jobs and four queued jobs in the
  Mathlib API round. Browser load also exercised four interactive Lean workers
  together with three local batch jobs and one remote native check.
- larapc06's admitted job pool was eight CPUs / 24 GiB. A native check reserved
  six CPUs / 18 GiB / three slots, with at most one native check per host.
  Remote running count never exceeded one in the sampled API rounds and partial
  browser capture. The outer
  worker slice remained capped at 16 CPUs / 48 GiB with swap disabled.
- During the 240-second PC resource sample, swap stayed at zero and cumulative
  OOM and OOM-kill counters did not increase. Peak anonymous memory was about
  740 MiB; peak total slice memory was 13.22 GiB, mostly existing file cache.
  Those observations cover that sample window, not every round.

The execution profile remained protocol 2, bundle
`27c56ca144377223a60761e837fbc8b33c8c7b5bb433f77ad9b420fe7528448f`, image
`sha256:0ef38c7e4ec01c43f82152aee50557730180111413a51dd01418aaf741c2a85d`.
No agents were run directly on a LARA PC; the resource probe only read the
worker slice's cgroup files through the ordinary user account.

One auxiliary Docker resource collector initially stopped when a short-lived
container exited between inspection and reading its `/proc` cgroup. Its
partial samples are not a complete monitoring run. The collector was fixed to
skip departed processes, and its 180-second API recheck capture completed
without errors. Job success and counts were verified independently of it.

This is evidence that ten users can compile these workloads successfully with
queueing. It does not determine maximum sustainable user count, certify ten
simultaneous language servers, measure prolonged fairness or cancellation, or
establish capacity for ten large native Mathlib builds or AI agents.

## Cleanup

All twenty disposable projects were removed through the application's trash
and permanent-delete APIs after their jobs finished. All ten test accounts were
revoked using the existing administrator helper; every test token then returned 401. Other accounts were preserved. Temporary token manifests were removed
from both the coordinator and test client. Cluster receipts and small private
evidence reports were retained; protected toolchains, shared dependencies and
user projects were preserved. The VM had approximately 95.94 GiB free after
fixture cleanup. The test did not restart either production service or worker.

Claude Code's read-only review (Opus 5.5, maximum effort) found no blocker to the
completed experiment. Subsequent harness hardening covers current chat-run and
follow-up endpoints as well as the legacy run route, fails on late monitoring
or page errors, validates and hashes fixture workloads, requires HTTPS off
loopback, and includes retry waits in latency measurements. The live recheck
rows predate this hardening; focused offline checks validate these changes.

## Reproduce with disposable accounts

The scripts deliberately have no production defaults and never provision or
delete users themselves. Run them against an operator-controlled deployment
with sufficient free disk. Use Node 24+ and the repo's npm dependencies.

Prepare ten **ordinary, disposable** accounts with names
`LF load YYYYMMDD a1b2c3d4 U01` through `U10`. Existing administrator account
creation (`POST /api/admin/users`, role `user`) returns their individual tokens.
Complete each profile using its token (`PUT /api/profile`, matching name).
For each user, create two projects with `POST /api/projects`, `autoRepair: false`,
and wait until both have status `ready`:

- Native project: name `<account name> Native`, preset `lean`, files
  `lean-toolchain` (`leanprover/lean4:v4.35.0`), `lakefile.toml`,
  `lake-manifest.json` and `Workload.lean`. The lakefile declares
  `name = "multi_user_compile"`, `defaultTargets = ["Workload"]`, and
  `[[lean_lib]]` / `name = "Workload"`. The manifest has version `1.1.0`,
  `packagesDir: ".lake/packages"`, `packages: []`, `name: "multi_user_compile"`,
  `lakeDir: ".lake"`. Generate 400 theorems named `assoc_0` through `assoc_399`
  inside a distinct `User01` through `User10` namespace:
  `theorem assoc_0 (a b c : Nat) : (a + b) + c = a + (b + c) := Nat.add_assoc a b c`.
- Mathlib playground: name `<account name> Mathlib.lean`, `kind: "single-file"`,
  `file: {path: "Scratch.lean", content: "..."}`. Generate `import Mathlib` and
  120 theorems in that user's namespace, for example
  `theorem arithmetic_0 : (0 : Nat) + 7 = 7 := by norm_num`.
  The playground API exposes the resulting source as `Main.lean`.

Save a private, mode-0600 JSON manifest with exactly ten entries:

```json
{
  "runTag": "LF load 20261113 a1b2c3d4",
  "accounts": [
    {
      "id": "<ordinary user ID>",
      "name": "LF load 20261113 a1b2c3d4 U01",
      "token": "<this disposable user's token>",
      "projects": {
        "native": {
          "id": "<project UUID>",
          "name": "LF load 20261113 a1b2c3d4 U01 Native"
        },
        "mathlib": {
          "id": "<project UUID>",
          "name": "LF load 20261113 a1b2c3d4 U01 Mathlib.lean"
        }
      }
    }
  ]
}
```

Use a fresh private output directory for each run. Common environment:

```sh
export STUDIO_RUN_LIVE_LOAD_TEST=1
export STUDIO_LOAD_FIXTURE=/private/path/fixture.json
export STUDIO_LOAD_OUTPUT=/private/path/results
export STUDIO_LOAD_ROUNDS=all
```

Run the API checker **on the coordinator**. It reads the owner token locally
only for session metrics, reads SQLite in read-only mode, and opens a status
channel using the existing controller identity. It never initializes another
controller. All compilations use the ten ordinary-user tokens. The reported
`suppliedRelease` identifies the operator-selected checkout; independently
record the serving process's release before testing. Worker status samples
cover the selected worker; attempt records can include other enabled nodes.

```sh
export STUDIO_LOAD_ORIGIN=http://127.0.0.1:8090
export STUDIO_LOAD_DATA_DIR=/path/to/deployment/data
export STUDIO_LOAD_RELEASE=/path/to/releases/FULL_40_CHARACTER_COMMIT
export STUDIO_LOAD_WORKER_ID=enrolled-worker-id
node scripts/check-multi-user-compile-live.mjs
```

Run the browser checker on a client with Chromium available. Transfer only the
disposable-user manifest to that client. Never transfer the owner token.

```sh
export STUDIO_LOAD_ORIGIN=https://your-deployment.example
export STUDIO_LOAD_OUTPUT=/private/path/browser-results
export STUDIO_LOAD_STUB_MODELS=1
# Optional: use an already installed Chromium-compatible browser.
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium
node scripts/check-multi-user-compile-live-ui.mjs
```

Set `STUDIO_LOAD_ROUNDS=mixed` for a single ten-user round. The API checker also
supports `native` or `mathlib`; the browser checker supports `native`, `mixed`
or `all`. Omit `STUDIO_LOAD_STUB_MODELS` when accounts have real configured
provider metadata. Both modes block attempted agent-run requests and require
their count to remain zero. Require process exit 0 **and** final report
`passed: true`.

Afterward, close browsers and wait for fixture jobs to settle. Verify each
project's owner and prefixed name, archive just those projects with
`POST /api/projects/<id>/trash`, then delete each returned project receipt with
`POST /api/trash/<trashId>/delete-forever` and an empty JSON body. Revoke only the
exact disposable IDs with the existing `scripts/remove-user.mjs` helper and
`STUDIO_DATA_DIR` set to the deployment data directory. Check that their tokens
return 401, then delete the manifests. Schedule this helper while accounts are
not being created or edited: it updates the account file outside the server's
in-process mutation queue. Preserve controller history and shared
runtime assets.
