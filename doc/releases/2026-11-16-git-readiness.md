# Git readiness — 16 November 2026

Use **Source control** to review and commit saved changes, browse local history,
and pull remote updates. Git remains available when Lean setup needs repair.
For a project without a repository, **Start version control** creates local
history without uploading files. See [the user guide](../UsingLeanFlow.md#search-and-publish).

## Changes

- Keep the pull repository and base branch independent of a fork selected for
  pushing. Show both destinations explicitly. A default pull from an imported
  project uses its base branch even when its local working branch is unpublished.
- Add a **History** tab with recent commits and copyable IDs. Label staged,
  unstaged, and untracked changes, and explain that a manual commit includes all
  listed eligible saved project files.
- Keep commit drafts and connection credentials available when a retry is
  needed. Saving author details does not clear an unrelated connection draft.
- Let users initialize local Git before selecting a Lean environment. Existing
  branches, commits, files, and ignore rules are preserved. Incomplete repository
  imports cannot silently become new, unrelated Git histories.
- Run application Git operations separately from Lean's dependency environment.
  A stale dependency binding no longer prevents pulling a setup fix. Active work,
  file recovery, project permissions, and containment checks still apply.
- Include both sides of renamed-file diffs and treat special filenames literally.
  Reject incomplete worker output and excessive changed-file reviews instead of
  acting on partial state. Mark shortened displayed diffs.
- Give Lemex read-only context for the saved branch, recent local commits,
  selected folder, and cached upstream counts. A fresh remote clone is never
  presented as containing unpublished local commits.
- Restrict agents' use of broad host connections to the current repository, its
  saved push destination, and URLs explicitly supplied by the user. Connections
  saved for an exact repository remain available for that repository. File
  contents and commit messages cannot grant host-token fallback. Provider tokens
  retain the privileges assigned by the host; repository-scoped tokens remain
  preferable.

## Validation

The full automated suite passed: 2,127 tests passed and one was skipped. Type
checking, formatting, lint, and the client build passed. Lint retains warnings;
the optional real TeX integration test requires an explicit opt-in and was
skipped.

Five browser suites passed: Git usability, Git workflows, Git connections,
import publishing, and private imports. They cover setup recovery, initialization,
history, separate destinations, failed requests, credentials, and busy states.
Browser fixtures use closed APIs and make no provider or real repository writes.

Real offline workers verified native clone, commit, push, and fast-forward pull;
account credentials and identity; sanitized publication of committed history;
non-fast-forward rejection; shallow-history export; rejection of untrusted TLS;
and removal of temporary credentials and worker homes. A separate fixture
confirmed that Git works with a stale Lean binding while ordinary Lean workers
continue to reject it. These checks use disposable repositories, with no provider
calls or external pushes.

Claude Opus 5.5 at maximum effort independently reviewed the current Git flows.
Its confirmed findings informed the branch-default fix, credential hardening,
and explicit warning about temporary agent commits. It found no demonstrated
authorization bypass or data-loss bug.

## Current boundaries

Lemex works in an isolated checkout. Requested source edits follow the existing
review or live-edit flow. An agent push updates the remote; use **Pull** with the
published repository and branch to bring its commits into the saved project's
history. A commit kept only in the temporary clone disappears when the run ends.
Use **Commit saved changes** for a durable local checkpoint without pushing.

Manual pull supports fast-forward history. Divergence preserves local files and
commits and requires reconciliation in a Git checkout. The app creates new
branches; existing-branch switching and merge/rebase conflict resolution do not
have dedicated controls. Remote operations use HTTPS repositories that already
exist. Shared projects selected from inside a larger repository cannot expose or
publish sibling history; private single-owner imports retain their existing
whole-repository workflow.
