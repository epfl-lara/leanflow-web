# Use LeanFlow Web

## Start in Mathlib Playground

Choose **Mathlib Playground** on the welcome screen, or expand **Playgrounds** in the sidebar and choose **New playground**. It opens a private scratch file with `import Mathlib`, using the prepared Lean and Mathlib versions. New playgrounds have distinct names such as `Scratch.lean` and `Scratch2.lean`. Paste your code and choose **Save**, or press **Ctrl+S** (**Cmd+S** on macOS).

Choose **Open .lean file** to upload one UTF-8 Lean file of at most 2 MiB. Its contents open as `Main.lean` in a new workspace. Files importing other modules from your own project need the full project instead.

Saved files appear under **Playgrounds** and can be reopened with their chats. Hover over a playground or focus it with the keyboard to show **Rename playground** and **Delete playground**. Rename changes its displayed name and download name, keeping its code and chats. Deleted playgrounds can be restored with **Undo** or **Trash**. Finish or stop active proof work before deleting a playground.

Use **Check File** to run a Lean check or **Download .lean** to download the current editor contents, including unsaved edits. File trees and source control appear after **Convert to project**; conversion keeps the file, chats, and pinned environment. Internally, the scratch module stays `Main.lean`, so renaming the playground does not change Lean imports.

The shared Mathlib template stays protected; your own playgrounds can be deleted. The server verifies the prepared environment once and reuses that check when opening new playgrounds. If you see **Checking the prepared Mathlib environment…**, other projects remain available while the check runs. Use **Retry Mathlib preparation** after a failed check. If Mathlib is not installed, ask the server administrator to prepare it. Opening a playground does not call Lemex automatically.

## Open a project

Choose **Import or create project**. Create a project with compatible library presets, paste a public repository URL, or upload a local folder.

GitHub subdirectory links work too, such as `https://github.com/epfl-lara/jordan-curve-theorem/tree/main/HOLLight-Lean`. For branch names containing `/`, use **More options → Branch or revision**. Imports keep their Lean version and dependency pins.

Use **Upload** or drag files/folders into the upload area. **Upload** in the Files header adds to the open project. The app asks about ambiguous project folders and name conflicts.

**Let Lemex repair setup if needed** allows an automatic configuration repair after setup fails. Use **Stop setup** to cancel.

## Stop a running check

While a project or file check runs, **Checking…** shows the elapsed wall-clock time in minutes. Use **Stop check** beside it to cancel the check and wait for its worker to stop. Fix or remove the blocking command before checking again.

## Use the project terminal

Choose **Terminal** in an open, prepared workspace. Save editor changes first, then run commands such as `lake env lean Main.lean` or `lake build`. The terminal starts in `/workspace` with the project's pinned Lean environment. It uses the same worker sandbox as Lemex: project files are writable, shared dependencies and toolchains are read only, and outbound network access is available. Host files, other projects, and provider credentials are not mounted into the terminal.

Type normally, use the arrow keys for command history, and press **Ctrl+C** to interrupt a command. Drag the separator above the terminal to resize it. Saved file changes refresh in the editor; unsaved editor text stays intact and the usual save conflict checks still apply. Terminal edits are saved directly. Run a Lean check to verify them.

The worker includes the Lemex CLI. Run `lemex` to open it, or `lemex --version` to see its version. Configure your own CLI login or provider inside the terminal if needed; the server's assistant credentials stay private. The terminal home is temporary, so save lasting work in `/workspace`.

Closing the terminal, changing workspaces, or disconnecting stops its shell and background processes. An idle terminal closes after 30 minutes without input. **Reconnect terminal** starts a new shell. Close the terminal before preparing again, using source control to change or publish the project, uploading files, or moving project data to Trash. **Stop all processes and move to Trash** also stops the terminal. Terminals share the server's worker capacity with editors, agents, setup, and checks.

## Ask about one proof

1. Open a Lean file. In **Outline**, click a declaration to navigate, then **+ Chat** to attach it.
2. Or use **Focus proof / lines** in chat: choose a declaration, use selected editor lines, or enter a range such as `70–74`.
3. Check **Focused on**, write your request, and send. Click the target to revisit it, or clear it to remove focus.

Targets belong to their chat. **Ask Lemex** uses the current proof or selection; **Optimize** also selects optimization mode. Save changed lines before sending a focused update during a run.

| Task             | Use it for                                               |
| ---------------- | -------------------------------------------------------- |
| **Proofs**       | Complete or repair a proof while keeping its statement.  |
| **Formalize**    | Turn mathematical prose into Lean statements and proofs. |
| **Optimize**     | Shorten a valid proof or reduce its elaboration work.    |
| **Ask & Search** | Find declarations or ask Lemex for explanations.         |

Compare optimization's token and heartbeat measurements: a shorter proof can take more elaboration work. Repair invalid proofs first.

## Follow and steer a chat

**New chat** starts a fresh conversation, listed after its first message. Use the chat selector to reopen one and its pencil to rename it.

Type **@** or use **Select files** to attach files; the active editor file is included too. **Options** controls model, reasoning effort, and live edits. Drafts and selections stay with their chats.

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

To jump to a declaration from the editor, put the cursor on its name and press **F12**, or right-click and choose **Go to Definition**. Project files open in the editor; definitions in Lean's installed library open in the scrollable read-only viewer at the position reported by Lean. Navigation between project files uses the usual unsaved-edit prompt.

In **Source control**, save files, review the diff, and enter a commit message. Use **New branch** if needed. To push, choose a repository and branch in **Publish**, then **Preview push**. Review it and provide a repository token with push permission; the token is used only for that push and stays out of the proof agent.

Deleted files, folders, projects, and chats go to **Trash**. Use **Restore** or the immediate **Undo** notice. To trash a project with active work, choose **Stop all processes and move to Trash** in its confirmation dialog. LeanFlow stops its checks, Lemex runs, and setup before moving it. Stop an active chat before deleting it.

In **Trash**, each item shows its size in MB. Files, folders, and projects show allocated disk space; chats show their stored content size. Shared dependency targets are excluded from project sizes. Click the red **X** to review the name, project, size, and deletion date. Choose **Delete Forever** to permanently remove it, or **Do Nothing** to keep it in Trash. Permanently deleting a project also removes its saved chats and runs.

Drag separators to resize panels; double-click to reset. If sign-in expires, use the recovery dialog with the same token to keep your edits and drafts.

For installation and hosting, see [Install and run](LemexWeb.md#install-and-run) and [Configuration](Configuration.md).
