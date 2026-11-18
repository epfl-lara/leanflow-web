# 25 participants in a shared project

Open a shared project in one browser tab. Double-click a file in **Files** to keep it open, then double-click another. Both files share the same continuous Lean session. Another browser tab or window with its own project editor can request another session. Each participant can edit, save and see collaborators' changes while waiting. Use **Check this file** in the waiting notice to compile the saved file and its imports. The result names the file. A second check on the current version is available if collaborators edited the project while Lean was working. **Check Project** verifies the project's default targets.

The coordinator runs commit `bbfcadc`. The rehearsal used its matching web client. The service restarted in an idle window. All three worker PCs retained their running processes and warmed Lean environments. The [main branch CI history](https://github.com/epfl-lara/leanflow-web/actions/workflows/ci.yml?query=branch%3Amain) records the Node and browser checks.

## Hosting profile

| Resource                                 | Competition setting                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Shared-project editor ceiling            | 32 sessions in a project                                                                            |
| Account editor ceiling                   | 3 running and 3 waiting per account                                                                 |
| Editor waiting list                      | 128 connections across the service, with no elapsed waiting deadline while connected and authorized |
| Managed, single-file editors             | Up to 32 sessions across four machines                                                              |
| Continuous editors for full repositories | Up to 4 on the coordinator, depending on other active work                                          |
| Assistants                               | Up to 3 running and 32 waiting, subject to available memory and each provider key's limit           |

Queue positions advance when capacity becomes available. An account at its own limit leaves other participants in the same project free to start. Waiting time does not count toward the active editor's inactivity timer. Closing an editor or leaving the project releases its place. An unattended active editor releases its worker after 30 minutes. Open files and shared saves work independently of continuous Lean diagnostics, goal states and completion.

The worker PCs handle certified single-file editors and eligible checks in the pinned public Mathlib environment, including files that import compiled public geometry modules. Files importing a project-local helper or using a custom configuration compile with the project's own Lake setup on the coordinator. A local file check takes a private source copy where the project fits the supported snapshot limits. Concurrent edits can continue. If the project changes, the result identifies the earlier sources. Full repository editors use the coordinator's 6 GiB workers. The service reserves part of the coordinator for checks and assistants. Three active assistants can reduce continuous repository capacity to three. See [worker budgets](../Hosting.md#storage-and-capacity) and [check scope](../ProjectChecks.md).

## Live rehearsal

On 18 November, 25 ordinary accounts opened two editor connections each on the deployed site. Each participant kept a checked Mathlib playground open in one window and opened both geometry files in the same shared repository in another. All 25 saw the same contents after 50 concurrent edits in **1.32 seconds**. No connection dropped unexpectedly.

| Measured activity                | Result                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Shared playground                | 25 continuous sessions, with 2 on the coordinator and 23 on the worker PCs                                |
| Selected geometry files          | 50 successful checks in two rounds of 25, completed in 44.5 seconds total                                 |
| Time from submission to result   | Median 12.6 seconds, 95th percentile 21.9 seconds, slowest 24.0 seconds                                   |
| Worker placement of those checks | 21 on PC05, 20 on PC06 and 9 on PC2                                                                       |
| Waiting participants             | 22 still held their place when the file checks finished                                                   |
| Full repository diagnostics      | All 25 participants received errors and then clean diagnostics in both files as sessions became available |

The mixed run took 2 minutes 47 seconds, including the deliberate hold of 25 first windows before participants took turns with the continuous editor. Three repository sessions fit during that hold and four fit after the playground windows closed. Holding a busy editor longer changes the next person's wait for continuous feedback. These timings describe the sample Lean environment and proofs.

### Imported local modules

The same 25 accounts then checked two files each in a separate small Lean repository with an imported local module and an unrelated broken target. All 50 selected-file checks passed without warnings on the coordinator. The median was 3.61 seconds, the 95th percentile was 5.28 seconds, and the slowest check took 5.37 seconds. Each round of 25 finished within 5.38 seconds. The two rounds together took 10.70 seconds of measured round time.

A collaborator edited the unrelated target during each round. Twelve results identified the earlier saved version they had compiled. The broken target failed when checked separately. The test restored and verified all three original files. A separate assistant rehearsal accepted 25 simultaneous requests from accounts using three simulated provider keys and completed all of them. It exercised both proof and search modes and preserved private histories and file conflicts. Provider response times require live inference and were outside that measurement.

### Incomplete proofs and compiler warnings

Two real selected-file checks, one in each repository, displayed a warning for `sorry` and cleared it when the proof was completed. In the full verification test, an anonymous example with `sorry` produced a compiler warning in both the initial and cached builds. Kernel replay of the exported declarations passed. Replacing the example with a named theorem using `sorry` failed independent verification. Completing the named theorem passed with no warning.

All four machines reported zero new out-of-memory kills during the rehearsals. The three test projects were purged and the 25 test accounts revoked. [Anonymized results](data/2026-11-18-shared-competition.json).

### Opening a file or starting a check during autosave

In an isolated browser, starting an autosave between pointer-down and pointer-up could swallow a click on **New file**. The client now keeps the file and folder dialogs available during a save. Creating a new file still waits for the previous draft to finish saving. The same save barrier protects file and project checks submitted from the toolbar or the editor queue.

## Reproduce the rehearsal

The opt-in [shared-project rehearsal](../../scripts/check-shared-competition-live.mjs) uses 25 separate ordinary accounts. It exercises the live collaboration, editor and check protocols. Browser regressions exercise the editor controls separately. Prepare a private fixture with the three disposable projects validated by the script. Keep the manifest at mode 0600 and the output directory at mode 0700. Run from a checkout with the dependencies installed.

```sh
STUDIO_RUN_LIVE_LOAD_TEST=1 \
STUDIO_LOAD_CHECK_SCOPE=file STUDIO_LOAD_EXTRA_WINDOW=1 \
STUDIO_LOAD_ORIGIN="$TEST_ORIGIN" STUDIO_LOAD_FIXTURE="$PRIVATE_FIXTURE" \
STUDIO_LOAD_OUTPUT="$PRIVATE_OUTPUT" node scripts/check-shared-competition-live.mjs
```

The shared Mathlib project contains two geometry files. The separate repository-shaped project imports a local module and includes an unrelated unfinished target. Each participant also opens a shared single-file playground in a separate window. The rehearsal holds those sessions open throughout two rounds of file checks. Finally, each participant introduces and corrects an ordinary Lean error in both files, then releases that continuous session. Remove the test projects and revoke the temporary accounts after the run.
