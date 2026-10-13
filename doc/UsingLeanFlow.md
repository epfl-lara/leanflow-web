# Use LeanFlow Web

## Open a project

Choose **Import or create project**. Create a project with compatible library presets, paste a public repository URL, or upload a local folder.

GitHub subdirectory links work too, such as `https://github.com/epfl-lara/jordan-curve-theorem/tree/main/HOLLight-Lean`. For branch names containing `/`, use **More options → Branch or revision**. Imports keep their Lean version and dependency pins.

Use **Upload** or drag files/folders into the upload area. **Upload** in the Files header adds to the open project. The app asks about ambiguous project folders and name conflicts.

**Let Lemex repair setup if needed** allows an automatic configuration repair after setup fails. Use **Stop setup** to cancel.

## Ask about one proof

1. Open a Lean file. In **Outline**, click a declaration to navigate, then **+ Chat** to attach it.
2. Or use **Focus proof / lines** in chat: choose a declaration, use selected editor lines, or enter a range such as `70–74`.
3. Check **Focused on**, write your request, and send. Click the target to revisit it, or clear it to remove focus.

Targets belong to their chat. **Ask Lemex** uses the current proof or selection; **Optimize** also selects optimization mode. Save changed lines before sending a focused update during a run.

| Task          | Use it for                                               |
| ------------- | -------------------------------------------------------- |
| **Proofs**    | Complete or repair a proof while keeping its statement.  |
| **Formalize** | Turn mathematical prose into Lean statements and proofs. |
| **Optimize**  | Shorten a valid proof or reduce its elaboration work.    |
| **Search**    | Find declarations or ask for explanations.               |

Compare optimization's token and heartbeat measurements: a shorter proof can take more elaboration work. Repair invalid proofs first.

## Follow and steer a chat

**New chat** starts a fresh conversation, listed after its first message. Use the chat selector to reopen one and its pencil to rename it.

Type **@** or use **Select files** to attach files; the active editor file is included too. **Options** controls model, reasoning effort, and live edits. Drafts and selections stay with their chats.

Use **Send update** for extra instructions or **Stop** to interrupt. Updates show whether they were accepted. Runs continue until finished or stopped; send another message afterward to continue.

Scroll up freely; **Jump to latest** resumes following output. Expand reasoning and activity as needed. Files and chat drafts remain available during a run.

## Review changes

**Edit files live** shows saved changes as Lemex works and preserves unsaved editor text. **View edits** shows the diff and Lean verification; intermediate edits may still contain errors.

After stopping, **Undo agent edits** restores changes without overwriting conflicting saved work. For review before saving, disable live edits, inspect the candidate, then **Apply changes**. Save your editor changes before applying or undoing.

## Search and publish

**Search** defaults to LeanExplore, with Loogle also available. Results show a **Type** or **Signature** and available documentation/source links. Check results against your project's versions.

In **Source control**, save files, review the diff, and enter a commit message. Use **New branch** if needed. To push, choose a repository and branch in **Publish**, then **Preview push**. Review it and provide a repository token with push permission; the token is used only for that push and stays out of the proof agent.

Deleted files, folders, projects, and chats go to **Trash**. Use **Restore** or the immediate **Undo** notice. Stop an active chat before deleting it.

Drag separators to resize panels; double-click to reset. If sign-in expires, use the recovery dialog with the same token to keep your edits and drafts.

For installation and hosting, see [Install and run](LemexWeb.md#install-and-run) and [Configuration](Configuration.md).
