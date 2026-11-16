---
kind: upgrade-guide
description: "The workspace-write boundary follows the Session's working directory instead of its original project, and a linked worktree's Git directories become writable."
---
# The `workspace-write` boundary follows the Session's working directory

English | [中文](guide.zh.md)

## Change

`ctx.sandboxPolicy.resolve({ session })` returns the Session's working directory as `workspaceRoot`: the checkout the Session works in. Before, it returned the original project recorded in the Session header for the whole Session. A Session that enters a worktree through `enter_worktree` or the forge New worktree option can now write only inside that worktree; the original project is no longer writable as a whole. The boundary moves with every Host move of the Session's directory, including SDK `setWorkingDirectory` (`set_working_directory` in Python) and a child started through `ctx.subagents.start({ cwd })`. A stored Session whose model moved into a subdirectory of its project resumes with that subdirectory as the boundary.

For a linked worktree, the policy derives the repository's common directory from the checkout's `.git` pointer, accepting only the `<common>/worktrees/<name>` layout Git writes with its `commondir` and `gitdir` pointers, and adds it to `additionalWritableRoots`, so `git commit` and `git checkout` work inside a worktree under `workspace-write`. That grant also covers the shared `.git/hooks` and `.git/config`, as a Session in the main checkout already had. On Windows only the harness `write` and `edit` tools honor that grant; confined processes keep their workspace and private-temp permissions.

The Files tree, directory listings and watches, deliverables and change summaries, open-in-app actions, and Session rows read the same directory. `WorkspaceChangesSummary.cwd` is the directory the turn started in, no longer the original project.

Who observes it: operators who relied on a worktree Session still writing its original project, deployments that granted a worktree's `.git` through `additionalWritableRoots`, and Host plugins that read `WorkspaceChangesSummary.cwd` as the original project.

## Migration

1. Remove `additionalWritableRoots` entries that only named a linked worktree's `.git/worktrees/<name>` or common `.git` directory from `cordis.yml`; keep entries for unrelated directories.
2. Where a task must write the original project after entering a worktree, leave with `exit_worktree()` or the forge panel's continue-in-project action, or keep the Session in the original project; the boundary follows that change. Where an SDK client moved the directory only to change where relative paths resolve, pass absolute paths or the shell's `workdir` instead. SDK `setWorkingDirectory` with the project path returns a stored Session from a subdirectory to its project.
3. In Host plugins that consume `ctx.workspaceChanges.summary`, read the original project from the Session header's `cwd`; `WorkspaceChangesSummary.cwd` is the directory listed `path` values are relative to.
4. Where `cordis.yml` sets the sandbox policy's `workspaceRoot` to bound Sessions without a header directory, set `defaultDirectory` of `@deepseek-ai/dsh-working-directory` to the same directory; that directory now bounds them.
5. Confirm: in a Session opened inside a linked worktree, `git commit` succeeds under `workspace-write`; after `enter_worktree`, a write to the original project outside the worktree is denied. The derived `.git` grant does not appear in the runtime context, which lists only configured extra directories.
