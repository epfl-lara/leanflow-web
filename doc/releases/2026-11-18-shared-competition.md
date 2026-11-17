# 25 participants in a shared project

Open a shared project in one browser tab. Double-click a file in **Files** to keep it open, then double-click another. Both files share the same continuous Lean session. Another browser tab or window with its own project editor can request another session. Each participant can edit, save and see collaborators' changes while waiting. Use **Check this file** in the waiting notice to compile the saved file and its imports. The result names the file. A second check on the current version is available if collaborators edited the project while Lean was working. **Check Project** verifies the project's default targets.

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

## Reproduce the rehearsal

The opt-in [shared-project rehearsal](../../scripts/check-shared-competition-live.mjs) uses 25 separate ordinary accounts. It exercises the live collaboration, editor and check protocols. Browser regressions exercise the editor controls separately. Prepare a private fixture with the three disposable projects validated by the script. Keep the manifest at mode 0600 and the output directory at mode 0700. Run from a checkout with the dependencies installed.

```sh
STUDIO_RUN_LIVE_LOAD_TEST=1 \
STUDIO_LOAD_CHECK_SCOPE=file STUDIO_LOAD_EXTRA_WINDOW=1 \
STUDIO_LOAD_ORIGIN="$TEST_ORIGIN" STUDIO_LOAD_FIXTURE="$PRIVATE_FIXTURE" \
STUDIO_LOAD_OUTPUT="$PRIVATE_OUTPUT" node scripts/check-shared-competition-live.mjs
```

The shared Mathlib project contains two geometry files. The separate repository-shaped project imports a local module and includes an unrelated unfinished target. Each participant also opens a shared single-file playground in a separate window. The rehearsal holds those sessions open throughout two rounds of file checks. Finally, each participant introduces and corrects an ordinary Lean error in both files, then releases that continuous session. Remove the test projects and revoke the temporary accounts after the run.
