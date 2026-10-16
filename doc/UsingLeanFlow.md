# Use LeanFlow Web

## Start in Mathlib Playground

Choose **Mathlib Playground** on the welcome screen, or expand **Playgrounds** in the sidebar and choose **New playground**. It opens a private scratch file with `import Mathlib`, using the prepared Lean and Mathlib versions. New playgrounds have distinct names such as `Scratch.lean` and `Scratch2.lean`. Paste your code and choose **Save**, or press **Ctrl+S** (**Cmd+S** on macOS).

Choose **Open .lean file** to upload one UTF-8 Lean file of at most 2 MiB. Its contents open as `Main.lean` in a new workspace. Files importing other modules from your own project need the full project instead.

Saved files appear under **Playgrounds** and can be reopened with their chats. Hover over a playground or focus it with the keyboard to show **Rename playground** and **Delete playground**. Rename changes its displayed name and download name, keeping its code and chats. Deleted playgrounds can be restored with **Undo** or **Trash**. Finish or stop active proof work before deleting a playground.

Use **Check File** to run a Lean check or **Download .lean** to download the current editor contents, including unsaved edits. Use **Convert to project** to enable source control and multi-file Lemex requests; conversion keeps the same folder, files, chats, and pinned environment. If a terminal command adds extra files to a playground, its file tree appears so you can open them. The editor and terminal both use `Main.lean`. The playground name, such as `Scratch.lean`, identifies the workspace and names its download; renaming it does not change Lean imports. The terminal header shows which workspace is connected, and switching workspaces closes its terminal.

The shared Mathlib template stays protected; your own playgrounds can be deleted. The server verifies the prepared environment once and reuses that check when opening new playgrounds. If you see **Checking the prepared Mathlib environment…**, other projects remain available while the check runs. Use **Retry Mathlib preparation** after a failed check. If Mathlib is not installed, ask the server administrator to prepare it. Opening a playground does not call Lemex automatically.

## Open a project

Choose **Import or create project**. Create a project with compatible library presets, paste an HTTPS repository URL, or upload a local folder.

GitHub and GitLab subdirectory links work too, such as `https://github.com/epfl-lara/jordan-curve-theorem/tree/main/HOLLight-Lean` or `https://gitlab.com/group/project/-/tree/main/Lean`. For branch names containing `/`, use **More options → Branch, tag, or commit**. Imports keep their Lean version and dependency pins.

For a private repository, choose **Git connections** and save a token for its host. Imports, publishing and terminal Git commands use the same account connection. A [GitHub fine-grained token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) needs access to the repository and **Contents: Read and write** to push, or **Read-only** to clone. A [GitLab token](https://docs.gitlab.com/user/profile/personal_access_tokens/) needs **write_repository** to push, or **read_repository** to clone. Enter the matching username for a deploy token. Select GitHub or GitLab and enter your own host for a self-hosted installation.

Connections are saved for your account on this server. Tokens are never displayed again. Connect the same host to replace its token, or choose **Disconnect** to stop future Git commands from using it. Revoke the token at your Git host to invalidate it everywhere. **Commit author** sets the name and email used by both Source control and terminal commits. Reopen an existing terminal after changing its author. Use your account email or its no-reply address.

For access for just one import, use **Private repository access**, or **Use a different token once** when a connection is already saved. This token overrides the connection for that operation and is cleared when the request starts. A private import downloads the full repository history.

For GitLab, use the HTTPS clone URL ending in `.git`. If a repository URL redirects, setup tries its `.git` form once on the same host. If it still fails, copy the direct HTTPS URL from the repository's clone menu and create a new import. Lemex cannot repair setup until the project files have been downloaded.

**Enable publishing changes back** is selected for repository imports. Leave **Working branch** blank to create a unique branch at the imported revision, or enter a branch name. If the name conflicts, the app preserves existing branches, chooses a unique alternative and shows the change. Importing never pushes changes. Clear the checkbox if you only want to work locally; you can enable publishing later in **Publish**. GitHub, GitLab and other HTTPS Git repositories are supported.

Use **Upload** or drag files/folders into the upload area. **Upload** in the Files header adds to the open project. The app asks about ambiguous project folders and name conflicts.

**Let Lemex repair setup if needed** allows an automatic configuration repair after setup fails. Use **Stop setup** to cancel.

**Retry setup** reuses a completed clone if fetching the selected revision failed. If repository authentication is needed, use its saved connection or enter another token. If cloning itself was interrupted and left partial files, create a new import as directed by the error. Partial files are preserved. A missing branch or tag needs a new import with an existing revision.

When available on the server, the specialized Lemex setup agent starts automatically after a recoverable setup failure. It diagnoses an isolated copy, proposes configuration repairs and validates them with Lean before they are applied. The progress card shows when repair is queued, its current activity and elapsed time. Repair has a 15-minute default deadline, including its wait for an assistant slot.

Setup shows its current stage, from preparing Lean and libraries to testing the environment. If automatic setup needs a configuration repair, **Lemex is repairing setup** appears while Lemex diagnoses the problem. **Testing the setup repair** appears before the checked configuration is accepted and setup retries. You can open another project while this runs.

**Project setup** above the editor shows the setup result, Lean version and a short source revision. Open it for the repository, folder, full revision and any warnings. **Setup output** names each build or check and reports its elapsed time. It belongs to the latest setup attempt, and long output shows a marked tail. The heading stays visible while you scroll the output. Dependency revision hashes include the package name. Lean errors and linter warnings remain visible; a ready environment can still contain project targets that need repair.

Use **Refresh setup** in an open project to recheck its environment. Valid compiled caches are reused. Choose the adjacent info icon for details about cache reuse and automatic repair. Stop active checks and chats, and close the terminal before refreshing.

## Rename a Lean symbol

Put the cursor on a declaration or reference and press **F2**, or right-click and choose **Rename Symbol**. Enter the final name, such as `blankC`. Existing qualifiers are preserved: `Cell.blank` becomes `Cell.blankC`.

Lean finds references across indexed project files, including files you have not opened. The changed files are marked in the file tree and stay in the browser until you choose **Save all** or press **Ctrl+S** (**Cmd+S** on macOS). You can open another affected file to inspect its edits. One editor undo reverses the whole rename. Existing unsaved edits are kept. Save all before starting another rename while other affected files have unsaved changes.

If another editor or an assistant changed a file on disk, Save all reports a conflict and leaves every saved file unchanged. Select the affected file and copy any draft changes you need. Choose **Reload file** to load its saved contents, merge your changes, then Save all again. Reload discards only that file's draft; edits in other files are kept. Choosing **Discard edits** when leaving discards unsaved changes in all affected files. Save or discard edits in an item before deleting it.

References depend on Lean's compiled project index. Prepare and build the project first. If an unopened module has no current index, rename asks you to build it. Use **Check Project**, then retry; updated indexes are loaded without reopening the project. After saving a rename, use Check Project to verify the result. Hidden text buffers retain undo history without running a separate Lean worker for every file.

## Read project documents

Choose **Lean docs** beside the search bar to read local copies of _Functional Programming in Lean_, _Theorem Proving in Lean 4_, and the _Lean Language Reference_. On a small screen, use the book icon beside search. The reading panel opens below the editor, leaving Lemex available beside it. Choose **Expand** for more reading space, or **Split view** to return. Close and reopen Lean docs to keep your current chapter.

Choose a book, follow its chapter links, or use **Search this book** to find matching chapters. **Contents** returns to the start. The displayed Lean version belongs to the downloaded book; your project's pinned Lean version stays unchanged.

With a prepared project open, choose **Ask Lemex** to add the current chapter to your draft. Select a passage first to include it. Your existing draft is preserved, and nothing is sent until you send the message. Lemex knows which books are installed and can search and read them directly. For Lean explanations, it is instructed to consult relevant chapters and include clickable book and chapter references when it uses them. These links open the cited page in Lean docs.

If a book is missing, ask the server administrator to [install the local books](Configuration.md#local-lean-books).

Choose a Markdown file such as `README.md` in **Files**. The editor highlights headings, emphasis, links, lists, and code fences. Choose **Preview Markdown** to read the formatted document, including tables and math written as `$x^2$`, `$$x^2$$`, `\(x^2\)`, or `\[x^2\]`. **Edit Markdown** returns to the same editor with your unsaved changes intact. Choose **Save** to save them.

Formatted previews support documents up to 512 KiB. Larger Markdown files stay available in the editor.

Choose a `.pdf` file to open a read-only PDF viewer. Use **Download PDF** or **Open PDF in new tab** if your browser cannot display it inline. Choose **Reload PDF** after changing a document through the terminal. PDFs can be uploaded alongside source files, up to 16 MiB per PDF and 32 MiB total per upload. PDF viewing does not compile LaTeX or attach PDF contents to Lemex chats.

Drag the scrollbar inside **Files** to scroll long lists. The separate strip to its right resizes the sidebar. You can also focus a separator and use the arrow keys.

## Edit and compile LaTeX

Open a `.tex` file to edit highlighted LaTeX beside its PDF. Choose **Options** in the PDF panel to select the root document, then choose **Build PDF**. Options also contains rebuild-on-save, the build log, and PDF reload and download controls. Collapse it to leave more room for the document. The build saves your open drafts first and stops if a file has a save conflict. Included `.tex` files, local styles, bibliographies, and PDF/PNG/JPEG figures are captured from the root document's folder and its subfolders. Generated files stay outside your project sources.

Enable **Rebuild on save** to update the PDF after saving edits. Unsaved typing does not trigger a build. Changes made through the terminal or Lemex mark an older preview as out of date. Choose **Build PDF** to capture the latest saved files. A failed build keeps the last successful PDF visible; open its reported errors to jump to the source line. **Stop** cancels a queued or running build.

Use **Ask & Search** to ask Lemex to read, edit, and compile a document. It can read the generated PDF's extracted text and use compiler diagnostics to repair LaTeX. Text extraction can omit figures and mathematical layout. Review-first edits remain candidates until accepted; live editing follows the option selected for Ask & Search. A successful TeX build does not verify Lean proofs.

The first version supports pdfLaTeX, automatic reruns through latexmk, and BibTeX. XeLaTeX, LuaLaTeX, Biber, custom compiler recipes, shell escape, and source-to-PDF navigation are not available. The server needs a separate [TeX worker image](Configuration.md#latex-compilation). Existing Lean toolchains stay pinned.

Put the root document at the common parent of its inputs and use paths such as `\input{chapters/introduction}`. Parent paths such as `../chapter.tex` and absolute paths are blocked by the isolated compiler. A root in a subfolder can include files below that subfolder.

## View evaluation results and stop a check

Put the cursor on a completed `#eval` command to see its output in **Goals & diagnostics**. For example:

```lean
#eval show IO Unit from do
  IO.println "Hello"
```

An interactive program such as LeanTui's `#eval chessMain []` waits for keyboard input. Remove that command, then use **Restart Lean** to recover the editor. Unsaved edits stay in the editor. Save your changes and open **Terminal** to run the project's executable, for example `lake exe chess-demo`.

While a project or file check runs, **Checking…** shows the elapsed wall-clock time in minutes. Use **Stop check** beside it to cancel the check and wait for its worker to stop. Fix or remove the blocking command before checking again.

If an older imported project reports a ProofWidgets `package-lock.json.hash` read-only error, stop its active checks and chats, then use **Refresh setup**. Setup prepares and tests the dependencies before sharing them read only, preserving the project's Lean version and dependency pins.

## Use the project terminal

Choose **Terminal** in an open, prepared workspace. Save editor changes first, then run commands such as `lake env lean Main.lean` or `lake build`. The terminal starts in the selected project folder with its pinned Lean environment. For a project imported from a repository subfolder, Git can access the containing checkout. Project files are writable, shared dependencies and toolchains are read only, and outbound network access is available. Host files, other projects, and the server's assistant credentials are not mounted into the terminal.

Type normally, use the arrow keys for command history, and press **Ctrl+C** to interrupt a command. Drag the separator above the terminal to resize it. Saved file changes refresh in the editor; unsaved editor text stays intact and the usual save conflict checks still apply. Terminal edits are saved directly. Run a Lean check to verify them.

The worker includes the Lemex CLI. Run `lemex` to open it, or `lemex --version` to see its version. Configure your own CLI login or provider inside the terminal if needed; the server's assistant credentials stay private. The terminal home is temporary, so save lasting work in the project folder.

Git is available for advanced work. Set up **Git connections** once, then use ordinary HTTPS Git commands such as `git status`, `git switch -c proof/my-change`, `git add Main.lean`, `git commit -m "Prove the lemma"` and `git push -u origin HEAD`. Clone another repository with `git clone https://github.com/owner/project.git`. Saved connections apply to their matching host. Run terminal commands only when you trust them to use your Git access; the terminal's commands can use those connections. Close the terminal before returning to Source control, so both views agree on the saved files and current branch.

For a new or uploaded project, add its remote first with `git remote add origin https://github.com/owner/project.git`, using your own repository URL. Repository imports already have an `origin` remote.

Closing the terminal, changing workspaces, or disconnecting stops its shell and background processes. An idle terminal closes after 30 minutes without input or output. Builds that continue producing output stay connected. **Reconnect terminal** starts a new shell. If terminal commands change Lean or Lake configuration, close the terminal and use **Retry setup** to prepare the updated environment. Close the terminal before preparing again, using source control to change or publish the project, uploading files, or moving project data to Trash. **Stop all processes and move to Trash** also stops the terminal. Terminals share the server's worker capacity with editors, agents, setup, and checks.

Finish a terminal build before starting a Lean check, and finish a check before starting another build in the terminal. Both can write the project's build cache. Git branch labels refresh when you close the terminal.

## Ask about one proof

1. Open a Lean file. In **Outline**, click a declaration to navigate, then **+ Chat** to attach it.
2. Or use **Focus proof / lines** in chat: choose a declaration, use selected editor lines, or enter a range such as `70–74`.
3. Check **Focused on**, write your request, and send. Click the target to revisit it, or clear it to remove focus.

Targets belong to their chat. **Ask Lemex** uses the current proof or selection; **Optimize** also selects optimization mode. Save changed lines before sending a focused update during a run.

| Task             | Use it for                                                 |
| ---------------- | ---------------------------------------------------------- |
| **Ask & Search** | Ask questions, find lemmas, or work on project text files. |
| **Proofs**       | Complete or repair a proof while keeping its statement.    |
| **Formalize**    | Turn mathematical prose into Lean statements and proofs.   |
| **Optimize**     | Shorten a valid proof or reduce its elaboration work.      |

Compare optimization's token and heartbeat measurements: a shorter proof can take more elaboration work. Repair invalid proofs first.

To formalize a document, open its PDF, TeX, Markdown, plain text, or other readable source, choose **Formalize**, and describe the statement or argument to translate. Use **Select files** or **@** to add other sources. You do not need to select an existing Lean file: Lemex can create one for the formalization. Source documents stay unchanged, and Lean output still receives independent verification. The standard worker can extract PDF text. If extraction is unavailable on an older worker or loses essential mathematics, provide the relevant passage or TeX source. Scanned pages may need OCR.

**Ask & Search** primarily helps with Lean, but also welcomes general questions, writing, planning, and open-ended tasks. Ask it to create or edit project text files and organize, rename, or delete non-Lean notes and documents. Use the file browser for Lean source renames and deletions. Questions and explanations leave files unchanged. Live edits are off by default: inspect the diff, then choose **Apply changes**. To save requested edits as Lemex works, enable **Options → Edit files live** before sending. This choice is saved separately from the other modes. Stop the run before undoing its edits. Lemex can use the workspace shell, Python, and other installed command-line tools in either editing mode. Lean source edits still receive independent Lean verification; ordinary conversation and non-Lean file tasks do not. Project setup files and dependencies stay protected.

## Follow and steer a chat

**New chat** starts a fresh conversation, listed after its first message. Use the chat selector to reopen one and its pencil to rename it.

Check **Current file** above your message. Its path is supplied automatically when available; you do not need to attach it to a task or update. Missing automatic context is skipped. Explicitly selected files and proof targets must be available. For PDFs, only the path is supplied. PDF contents are not attached.

Type **@** or use **Select files** to attach extra files. **Options** controls model, reasoning effort, and live edits. Drafts and selections stay with their chats.

Use **Send update** for extra instructions or **Stop** to interrupt. Updates show whether they were accepted. Runs continue until finished or stopped; send another message afterward to continue.

Scroll up freely; **Jump to latest** resumes following output. Reasoning appears between replies in separate Show/Hide sections. Files and chat drafts remain available during a run.

With live edits on, the work status shows whether any files have been updated. Scratch checks do not change your editor; changes appear when Lemex writes to a project file. Saved edits still need final Lean verification. In review-first mode, files update after you accept the candidate changes.

Use **View edits** to inspect saved changes during a run. If **Final checks need attention** appears, select **Review checks** to see why the server did not verify the result.

## Review changes

**Edit files live** shows saved changes as Lemex works and preserves unsaved editor text. **View edits** shows the diff and Lean verification; intermediate edits may still contain errors.

After stopping, **Undo agent edits** restores changes without overwriting conflicting saved work. For review before saving, disable live edits, inspect the candidate, then **Apply changes**. Save your editor changes before applying or undoing.

## Search and publish

Type into the wide search box at the top of the workspace and press **Enter**. Choose **LeanExplore** for a description or **Loogle** for a type pattern. General search works without an LLM connection and without opening Lemex. For explanations and assisted searches, open Lemex and choose **Ask & Search**.

Results show a **Type** or **Signature** and available documentation/source links. Check results against your project's versions. Press **Escape** or close the results panel to dismiss it; focus the search box to reopen your results.

Choose **Open locally** to view a module from the project's pinned Lean installation or installed library packages. The viewer is read only and leaves your editor's unsaved changes intact. It selects the declaration when its signature matches the local file; otherwise it shows the module without guessing a line from another version. **Open source** opens the search index's version on the web.

To jump to a declaration from the editor, hold **Alt** (**Option** on macOS) and click its name. You can also press **F12** or right-click and choose **Go to Definition**. Project files open in the editor; definitions in Lean's installed library open in the scrollable read-only viewer at the position reported by Lean. Navigation between project files uses the usual unsaved-edit prompt. Use **Ctrl+click** (**Cmd+click** on macOS) to add a cursor for editing.

In **Source control → Changes**, save files, review the diff, and enter a commit message. Use **Create branch** if you need a new branch. An import with publishing enabled already has a working branch.

Choose **Publish** in the project header, or the **Publish** tab in Source control. If publishing was disabled during import, choose **Enable publishing**. The imported repository is filled in automatically. You can replace it with an existing fork where you have write access.

Choose the branch to push and the repository host. GitHub and GitLab are detected for their public services; select the provider for a self-hosted installation, or **Other** for ordinary Git pushing. **Merge into branch** selects the target for a later PR or MR; leave it blank to use the repository's default branch.

Choose **Preview push**, review the commit, destination and branch, then choose **Publish reviewed commit**. The matching saved Git connection is used automatically. If needed, open **Use a different token once** to override it for this push; with no connection, enter a token or open **Git connections**. The one-use token is cleared when the request starts. The server rechecks the reviewed commit and does not force-push. Saved changes must be committed to be included.

You can close Source control during a push and reopen it later. After the push succeeds, its confirmed branch and PR/MR link remain available. Public imports stay shallow; publishing retrieves missing history in a temporary export without copying the dependency cache. Imports made with a repository token include their full history.

After a confirmed GitHub push, choose **Open pull request on GitHub**. For GitLab, choose **Open merge request on GitLab**. These links open the provider's request form with the published branch selected. Review the target, title and description, then submit the form there. When pushing to a fork, select the upstream repository in that form to contribute back. Other Git hosts keep their usual branch and review workflow.

Deleted files, folders, projects, and chats go to **Trash**. Use **Restore** or the immediate **Undo** notice. To trash a project with active work, choose **Stop all processes and move to Trash** in its confirmation dialog. LeanFlow stops its checks, Lemex runs, and setup before moving it. Stop an active chat before deleting it.

In **Trash**, each item shows its size in MB. Files, folders, and projects show allocated disk space; chats show their stored content size. Shared dependency targets are excluded from project sizes. Click the red **X** to review the name, project, size, and deletion date. Choose **Delete Forever** to permanently remove it, or **Do Nothing** to keep it in Trash. Permanently deleting a project also removes its saved chats and runs.

To empty Trash, choose **Delete All**, review the item count and total size, then choose **Delete Forever**. **Do Nothing** keeps the items. If an item cannot be deleted, the dialog explains why and lets you retry the remaining items. Items added to Trash after the confirmation opened are kept.

Drag separators to resize panels; double-click to reset. If sign-in expires, use the recovery dialog with the same token to keep your edits and drafts.

For installation and hosting, see [Install and run](LemexWeb.md#install-and-run) and [Configuration](Configuration.md).
