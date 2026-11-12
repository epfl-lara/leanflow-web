# Project sharing

Open **Share project** beside a project to give another account access. Search for the account name, or create an Editor or Viewer invitation link. The recipient signs in and opens the link to join. Every project starts with its creator as an Admin.

## Roles

| Role   | Access                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Viewer | Read and download project files. Read their own existing chats.                                                                 |
| Editor | Edit files, run their own agents and checks, prepare the environment, and use a private terminal and their own Git connections. |
| Admin  | Everything an Editor can do, plus manage sharing, rename, archive, restore, or permanently delete the project.                  |

Grant Admin only to a named account you trust. The sharing dialog requires acknowledging that the account can change access and delete the project. Admin invitation links are unavailable. A project must keep at least one Admin; add another before removing or demoting the last one. The original creator has no special project permission after delegation.

A link grants ongoing account membership when redeemed. Revoking the link stops future joins. To remove an account that already joined, remove its membership as well. Downgrading a role or removing access closes that account's project connections and stops its active work. Promotions preserve ongoing sessions. Unsaved editor drafts stay in its tab and can be downloaded.

## Personal conversations and credentials

Project membership shares project files. Each account keeps its own chats, prompts, reasoning, run history, API key, provider, model, reasoning effort, Git connections, and commit identity. A Viewer confirms their profile but does not need an API key to read a shared project. An Admin cannot open another member's conversations or keys through sharing.

Each agent receives an isolated copy of the selected project and its initiating account's configuration. Shared dependencies remain read only. The agent does not receive a parent project directory, other projects, or another member's worker home. Once a subfolder project is shared, Source control cannot use its containing repository, including for the original importer. A private import remains usable by its sole original account; parent-repository access is not delegated with project roles. Import the folder as a standalone project to use Git without exposing files outside it.

Agents coordinate through saved file revisions. There is no automatic exchange of private prompts or agent messages.

## Concurrent file updates

Editable text uses an authenticated project connection and a Yjs document for each open file. Concurrent browser edits merge. Undo and Redo affect the current user's edits without undoing collaborators' changes. The server acknowledges an edit after saving it through the project's version-checked write queue. Updates to other tabs contain incremental changes; reconnecting transfers the document state again.

Agent and terminal changes enter through checked file transactions and then update open documents. If a touched file changed since the agent or terminal's baseline, publication pauses rather than overwriting the newer file. Agent changes remain available in that account's run. Restart the task from the current project or review the conflicting edits. Verification also checks the saved context, so a change to an imported file can require a fresh check.

Configuration files use the normal save path and its active-work checks. They do not use the live text connection. Changing Lean or Lake configuration requires preparing the shared environment again. The selected Lean release and dependency pins are preserved.

If the connection fails, keep the tab open until saving succeeds. Unacknowledged edits remain local. If both the saved file and a local draft changed while a document was disconnected, download the draft before reloading. The interface does not silently replace it.

## Private terminals and recovery

Each terminal opens a private working copy. Its text file changes publish to the project with version checks. A conflict pauses publication and preserves the private copy. Close the terminal and choose **Recover terminal files** to download it. Recovery downloads belong to the account that opened the terminal, including after project access is removed or the shared project is deleted. Open your account settings and choose **Private terminal files** to find copies from projects you can no longer access. Keep at most eight copies per account; download what you need, then use **Discard recovery copy** to free a slot. Copies that are open or still publishing their final changes cannot be downloaded or discarded. They appear in recovery only after closing; interrupted copies remain available after a server restart.

Terminal Git metadata is local to the private copy. Use **Source control** for the saved project's history and publication. Terminal Git requests use the current account's saved Git connection. Build output, secret paths, dependency caches, and Git metadata are not copied into shared source files. Generated binary or oversized files stay in the private copy for recovery and explicit upload. Other text files continue publishing. A temporarily invalid text file keeps its last published version until it becomes editable again.

## Concurrency and hosting

The file-write queue covers short filesystem commits. Project copies, worker admission, setup, network operations, and worker shutdown do not wait for the document queue while holding that file queue. Document queues call the existing version-checked writer and retry bounded filesystem races. Cancellation stops workers before final terminal publication; queued writes recheck current membership.

Preparation temporarily pauses live saves. Other members see the setup status; preserved drafts resume saving when setup finishes. Preparation, Git history changes, and project deletion check activity across every member. They report active collaborator work instead of stopping it. Each Lean editor still uses its own worker. Before increasing team size, review the editor, worker, agent, and queue limits in [Configuration](Configuration.md) and follow the capacity guidance in [Hosting](Hosting.md).

Live editing initially allows 128 connections across the server, 12 per account, 16 live files per tab, 32 per account, and 128 retained documents with 64 MiB of encoded document state. Worker limits separately control active Lean sessions. Review these limits and measure memory, save traffic, and retained history before expanding to larger teams.

## Validate sharing before deployment

Run the normal checks, then exercise real isolated accounts and workers:

```sh
npm test
npm run check
npm run lint
npm run build
node scripts/check-project-sharing-live.mjs
node scripts/check-project-sharing-ux.mjs
node scripts/check-project-sharing-editor.mjs
node scripts/check-project-sharing-runtime.mjs
```

The live checks create separate test accounts, projects, browser contexts, and worker homes. They use the installed worker image and pinned Lean toolchain. They make no inference requests. `STUDIO_TEST_WORKER_IMAGE` can select an installed test image, and `STUDIO_TEST_TOOLCHAIN_DIR` can supply existing toolchains through read-only mounts. Reports are saved under `.runtime/sharing-validation/`; fixture accounts, projects, and workers are removed after each run.

These checks cover a small team on one server. They do not replace a representative load test before a larger rollout. Verification may still request a retry when the project keeps changing throughout its bounded capture attempts.
