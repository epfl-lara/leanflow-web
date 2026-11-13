# Project sharing

Open **Share project** beside a project to give another account access. Search for the account name, or create an Editor or Viewer invitation link. The recipient signs in and opens the link to join. Every project starts with its creator as an Admin.

## Roles

| Role   | Access                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Viewer | Read and download project files. Read their own existing chats.                                                                 |
| Editor | Edit files, run their own agents and checks, prepare the environment, and use a private terminal and their own Git connections. |
| Admin  | Everything an Editor can do, plus manage sharing, rename, archive, restore, or permanently delete the project.                  |

Grant Admin only to a named account you trust. The sharing dialog requires acknowledging that the account can change access and delete the project. Admin invitation links are unavailable. A project must keep at least one Admin; add another before removing or demoting the last one. The original creator has no special project permission after delegation.

The API also permits Viewers to run read-only Lean checks and TeX compilation in their own isolated jobs. These jobs cannot publish source changes, but they share worker capacity and can temporarily block project preparation. The interface currently shows these controls only to Editors and Admins.

A link grants ongoing account membership when redeemed. Revoking the link stops future joins. To remove an account that already joined, remove its membership as well. Downgrading a role or removing access closes that account's project connections and stops its active work. Promotions preserve ongoing sessions. Unsaved editor drafts stay in its tab and can be downloaded.

## Personal conversations and credentials

Project membership shares project files. Each account keeps its own chats, prompts, reasoning, run history, API key, provider, model, reasoning effort, Git connections, and commit identity. A Viewer confirms their profile but does not need an API key to read a shared project. An Admin cannot open another member's conversations or keys through sharing.

Each browser tab stays bound to the account that opened it. Signing into another account in a second tab does not move drafts, private history, or assistant requests into that account. The original tab asks you to sign in again as its account. Older tabs must copy or download unsaved work and reload before continuing.

Each agent receives an isolated copy of the selected project and its initiating account's configuration. Shared dependencies remain read only. The agent does not receive a parent project directory, other projects, or another member's worker home. Once a subfolder project is shared, Source control cannot use its containing repository, including for the original importer. A private import remains usable by its sole original account; parent-repository access is not delegated with project roles. Import the folder as a standalone project to use Git without exposing files outside it.

Agents coordinate through saved file revisions. There is no automatic exchange of private prompts or agent messages.

Disposable verification copies are removed after their workers stop. The candidate used for reviewing a run stays private and available. Retained runs and history are never deleted automatically. Storage warnings and reserved free space protect admission for new imports, setup, and private copies; existing saves, downloads, cancellation, and recovery stay available. Expanding the filesystem makes the added space available without a restart. See [project storage](Storage.md) for thresholds and retention guidance.

## Concurrent file updates

Editable text uses an authenticated project connection and a Yjs document for each open file. Concurrent browser edits merge. Undo and Redo affect the current user's edits without undoing collaborators' changes. The server acknowledges an edit after saving it through the project's version-checked write queue. Updates to other tabs contain incremental changes; reconnecting transfers the document state again.

Agent and terminal changes enter through checked file transactions and then update open documents. If a touched file changed since the agent or terminal's baseline, publication pauses rather than overwriting the newer file. Agent changes remain available in that account's run. Restart the task from the current project or review the conflicting edits. Verification also checks the saved context, so a change to an imported file can require a fresh check.

Open editors follow terminal moves when an unchanged file can be identified uniquely. For moves involving several identical files, use the file browser's **Rename** or **Move to folder** action. If an old file still has a draft, download it before discarding it and open the file at its new location.

If a saved file disappears, its unsaved draft stays in a read-only view. Other files can still save and receive collaborators' changes. Choose **Download draft** or **Save a copy** to recover the draft under a new name. Saving a copy never replaces a different existing file. This also applies when the deletion happened while your connection was interrupted. Leaving the project still asks you to keep or discard remaining drafts.

Large batches hold the write queue for that project until they finish. Another save in the same project can wait for the batch; your local draft remains editable and other projects keep responding. Keep the tab open until saving is confirmed. Replacing an existing file preserves its name throughout the replacement, so readers see complete old or new contents rather than a temporarily missing file.

Configuration files use the normal save path and its active-work checks. They do not use the live text connection. Changing Lean or Lake configuration requires preparing the shared environment again. The selected Lean release and dependency pins are preserved.

If the connection fails, keep the tab open until saving succeeds. Files that switch to normal version-checked saving stay in that mode until you switch to another project and back, or reload the page, which prevents the same edit from being saved twice during reconnection. Unacknowledged edits remain local. If both the saved file and a local draft changed while a document was disconnected, download the draft before reloading. The interface does not silently replace it.

If an edit exceeds the file limit or includes unsupported text, remove that text or use Undo. Corrected text resumes saving after reconnection. Other members' edits and your remaining draft are preserved.

## Private terminals and recovery

Each terminal opens a private working copy. Its text file changes publish to the project with version checks. A conflict pauses publication and preserves the private copy. Close the terminal and choose **Recover terminal files** to download it. Recovery downloads belong to the account that opened the terminal, including after project access is removed or the shared project is deleted. Open your account settings and choose **Private terminal files** to find copies from projects you can no longer access. Keep at most eight copies per account; download what you need, then use **Discard recovery copy** to free a slot. Copies that are open or still publishing their final changes cannot be downloaded or discarded. They appear in recovery only after closing; interrupted copies remain available after a server restart.

Choose **Choose individual files** if the ZIP is too large. Downloads allow up to 32 MiB per file and 64 MiB per ZIP. A larger file does not prevent downloading smaller files individually. Ask the server administrator to recover files above the individual limit before discarding the copy. Listing and ZIP downloads also stop at 12,000 permitted entries or 50,000 scanned entries. If a copy exceeds those limits, ask the server administrator to recover it; repeatedly retrying the listing will not help.

Terminal Git metadata is local to the private copy. Use **Source control** for the saved project's history and publication. Terminal Git requests use the current account's saved Git connection. Build output, secret paths, dependency caches, and Git metadata are not copied into shared source files. Generated binary or oversized files stay in the private copy for recovery and explicit upload. Other text files continue publishing. A temporarily invalid text file keeps its last published version until it becomes editable again.

Agents also use the initiating account's saved Git connections for HTTPS commands in separate checkouts. Project access is checked again for each credential request. A saved token is never shared with another member. Ask an agent to reconcile or publish changes when needed; use **Source control → Pull** after the run to update the saved project's history. Pull waits for active project work to finish and refuses to overwrite local edits or merge diverging commits automatically.

## Concurrency and hosting

Opening a terminal saves pending browser edits before creating its private copy. Later browser edits do not update an already open terminal. If those edits conflict with a terminal command, a persistent notice explains how to recover the private files and start a new terminal from the latest saved project. Brief file changes during a terminal scan retry automatically; actual version conflicts still preserve the private copy.

Terminal synchronization publishes files. Use the file browser to create, move, or remove empty folders.

Document updates and private-copy publication share a version-checked file-write queue. Git commands inside that queue report busy worker capacity immediately instead of waiting for a slot. Cancellation stops workers before final terminal publication; queued writes recheck current membership.

Scanning saved project inputs stops after 30 seconds. A timed-out scan releases the file-write queue and reports an error. Retry the check, or move large generated files out of the project before retrying.

Preparation temporarily pauses live saves. Other members see the setup status; preserved drafts resume saving when setup finishes. Preparation, Git history changes, and project deletion check activity across every member. They report active collaborator work instead of stopping it. Each Lean editor still uses its own worker. Before increasing team size, review the editor, worker, agent, and queue limits in [Configuration](Configuration.md) and follow the capacity guidance in [Hosting](Hosting.md).

Live editing initially allows 128 connections across the server, 12 per account, 16 live files per tab, 32 per account, and 128 retained documents with 64 MiB of encoded document state. Worker limits separately control active Lean sessions. Review these limits and measure memory, save traffic, and retained history before expanding to larger teams.

New multi-file updates sync private recovery copies before replacing files. The database stores bounded metadata instead of embedding source text in large JSON records, so other projects can keep responding during large updates. After a restart, an unfinished update restores every original file; an update with a verified commit record keeps every saved change. Recovery records allow at most 12,000 files and 32 MiB of original content per update; editor batch saves and agent changes retain their 1,000-file limits, and uploads retain their 5,000-file limit. If a file has an unexpected edit, a symbolic link, or a damaged recovery record, editing and jobs pause only for that project. You can still read and download available files and local drafts and manage sharing. After a temporary storage problem clears, a project Admin can choose **Retry file recovery** without restarting the server. Recovery checks that the project has no active work and never overwrites unexpected content. Archiving stays blocked until recovery succeeds.

If retry still fails, ask the server administrator to back up the project, its retained history, and the workspace database before making manual changes. Server logs identify the project, transaction, relative file, and failing check. The matching record is in `pending_project_transactions` in `workspaces.sqlite`; originals remain in the transaction's `history/<project>/<transaction>/before/` directory or its durable recovery record. Resolve the storage problem or recover the expected original files, then retry through the project. Do not delete pending records or change their hashes to bypass a conflict. Older interrupted updates appear under **Review older interrupted updates**. A project Admin can download retained originals, then confirm **Restore originals** or **Keep current files**. Restoring checks every saved file version again and keeps a backup of the current files. Unexpected later edits disable automatic restore; keeping the current files preserves them and resumes editing. Older originals are retained in history. Damaged or unsafe storage still needs a server administrator; recovery never bypasses those checks. These rules also apply to private projects. External writes from administrator shells or unsupported workers can race project operations; stop those writers before recovery. Empty folders created by an interrupted update may remain.

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
node scripts/check-session-project-drafts-ui.mjs
node scripts/check-terminal-opening-ui.mjs
node scripts/check-collaboration-sync-ui.mjs
node scripts/check-editor-startup-ui.mjs
node scripts/check-session-account-switch-ui.mjs
node scripts/check-account-setup-invitation-ui.mjs
node scripts/check-storage-status-ui.mjs
node scripts/check-legacy-file-recovery-ui.mjs
node scripts/check-project-transactions-runtime.mjs
node scripts/check-worker-capacity-runtime.mjs
node scripts/check-project-sharing-runtime.mjs
```

The live checks create separate test accounts, projects, browser contexts, and worker homes. They use the installed worker image and pinned Lean toolchain. They make no inference requests. `STUDIO_TEST_WORKER_IMAGE` can select an installed test image, and `STUDIO_TEST_TOOLCHAIN_DIR` can supply existing toolchains through read-only mounts. Reports are saved under `.runtime/sharing-validation/`; fixture accounts, projects, and workers are removed after each run.

These checks cover a small team on one server. They do not replace a representative load test before a larger rollout. Verification may still request a retry when the project keeps changing throughout its bounded capture attempts.
