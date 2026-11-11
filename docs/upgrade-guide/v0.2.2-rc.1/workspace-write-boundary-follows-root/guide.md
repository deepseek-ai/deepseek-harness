---
kind: upgrade-guide
description: "The workspace-write boundary follows the Session's workspace root instead of its original project, and a linked worktree's Git directories become writable."
---
# The `workspace-write` boundary follows the Session's workspace root

English | [中文](guide.zh.md)

## Change

`ctx.sandboxPolicy.resolve({ session })` returns the Session's workspace root as `workspaceRoot`: the checkout the Session works in. Before, it returned the original project recorded in the Session header for the whole Session. A Session that enters a worktree through `create_worktree` or the forge New worktree option can now write only inside that worktree; the original project is no longer writable as a whole. The boundary moves with every Host move of the Session's directory, including SDK `setWorkingDirectory` (`set_working_directory` in Python) and a child started through `ctx.subagents.start({ cwd })`; a directory change recorded before this release without the `workspace` marker does not move it.

For a linked worktree, the policy derives the repository's common directory from the checkout's `.git` pointer, accepting only the `<common>/worktrees/<name>` layout Git writes with its `commondir` and `gitdir` pointers, and adds it to `additionalWritableRoots`, so `git commit` and `git checkout` work inside a worktree under `workspace-write`. That grant also covers the shared `.git/hooks` and `.git/config`, as a Session in the main checkout already had. On Windows only the harness `write` and `edit` tools honor that grant; confined processes keep their workspace and private-temp permissions.

The Files tree, directory listings and watches, deliverables and change summaries, new sidebar terminals, `@` file completion, the skill catalog, project-instruction discovery, and the LSP workspace read the same root. `WorkspaceChangesSummary.cwd` is replaced by `root`, and `TerminalEnvironment.cwd` names the root.

Who observes it: operators who relied on a worktree Session still writing its original project, deployments that granted a worktree's `.git` through `additionalWritableRoots`, and Host plugins that read `WorkspaceChangesSummary.cwd`.

## Migration

1. Remove `additionalWritableRoots` entries that only named a linked worktree's `.git/worktrees/<name>` or common `.git` directory from `cordis.yml`; keep entries for unrelated directories.
2. Where a task must write the original project after entering a worktree, leave with `exit_worktree()` or the forge panel's continue-in-project action, or keep the Session in the original project; the boundary follows that change. Where an SDK client moved the directory only to change where relative paths resolve, pass absolute paths or the shell's `workdir` instead.
3. Replace reads of `WorkspaceChangesSummary.cwd` with `root` in Host plugins that consume `ctx.workspaceChanges.summary`.
4. Confirm: in a Session opened inside a linked worktree, `git commit` succeeds under `workspace-write`; after `create_worktree`, a write to the original project outside the worktree is denied. The derived `.git` grant does not appear in the runtime context, which lists only configured extra directories.
