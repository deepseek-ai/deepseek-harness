---
kind: upgrade-guide
description: "The workspace-write boundary follows the Session's working directory instead of its original project, so a Session in a worktree can no longer write its original project."
---
# The `workspace-write` boundary follows the Session's working directory

English | [中文](guide.zh.md)

## Change

`ctx.sandboxPolicy.resolve({ session })` returns the Session's working directory as `workspaceRoot`: the checkout the Session works in. Before, it returned the original project recorded in the Session header for the whole Session. A Session that enters a worktree through `enter_worktree` or the forge New worktree option can now write only inside that worktree; the original project is no longer writable. The boundary moves with every Host move of the Session's directory, including SDK `setWorkingDirectory` (`set_working_directory` in Python) and a child started through `ctx.subagents.start({ cwd })`; a `working-directory/change` recorded before this release does not move it.

The repository's Git directory lies outside a linked worktree. Under `workspace-write`, `git add`, `git commit`, and other commands that write it are therefore denied inside a worktree unless a grant covers that directory. Before, a worktree inside the original project shared the project's boundary, which contained `.git`. The policy reads no Git files; the worktree service mounts the [linked-worktree grant](../../../../packages/experimental/sandbox-policy-git/README.md), which registers that directory except on Windows.

The Files tree, directory listings and watches, deliverables and change summaries, open-in-app actions, and Session rows read the same directory. `WorkspaceChangesSummary.cwd` is the directory the turn started in, no longer the original project.

Who observes it: operators and models that commit from a worktree Session under `workspace-write` without that grant, operators who relied on a worktree Session still writing its original project, and Host plugins that read `WorkspaceChangesSummary.cwd` as the original project.

## Migration

1. Without the worktree service, to let worktree Sessions commit under `workspace-write`, add the repository's Git directory, such as `/repo/.git`, to `additionalWritableRoots` of `@deepseek-ai/dsh-sandbox-policy` in `cordis.yml`, or register it for one Session from a Host plugin with `ctx.sandboxPolicy.registerWritableRoot(session, directory)`. The grant also covers `.git/hooks` and `.git/config`; use it for trusted work only. Windows processes ignore additional writable roots, so the grant does not reach `git` there. Without an effective grant, the model requests escalation for each such command where approvals are enabled.
2. Where a task must write the original project after entering a worktree, leave with `exit_worktree()` or the forge panel's continue-in-project action, or keep the Session in the original project; the boundary follows that change. Where an SDK client moved the directory only to change where relative paths resolve, pass absolute paths or the shell's `workdir` instead.
3. In Host plugins that consume `ctx.workspaceChanges.summary`, read the original project from the Session header's `cwd`; `WorkspaceChangesSummary.cwd` is the directory listed `path` values are relative to.
4. Where `cordis.yml` sets the sandbox policy's `workspaceRoot` to bound Sessions without a header directory, set `defaultDirectory` of `@deepseek-ai/dsh-working-directory` to the same directory; that directory now bounds them.
5. Confirm: after `enter_worktree`, a write to the original project outside the worktree is denied, and, on macOS or Linux, `git commit` in the worktree succeeds.
