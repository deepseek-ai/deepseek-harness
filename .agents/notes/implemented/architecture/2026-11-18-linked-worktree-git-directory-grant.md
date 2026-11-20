# Agent Note: Linked worktrees get a validated grant of the repository Git directory

Status: implemented

English | [中文](2026-11-18-linked-worktree-git-directory-grant.zh.md)

## Problem

The `workspace-write` boundary of a Session is the directory it works in, and the sandbox policy [reads no Git layout](2026-11-03-session-workspace-root.md). A linked worktree stores its index, its `HEAD`, and the repository's objects and refs in the repository's Git directory, outside the worktree. A Session that enters a worktree therefore cannot run `git add` or `git commit` under `workspace-write`, the default mode of the shipped compositions, without an escalation for each command.

A grant derived from the worktree has a forgery risk: the Session can write every file in its directory, including the `.git` file that names the Git directory.

## Decision

The plugin `@deepseek-ai/dsh-sandbox-policy-git` registers the shared Git directory of the worktree a Session works in through `ctx.sandboxPolicy.registerWritableRoot`. The worktree service mounts it, so every composition that can move a Session into a worktree has it. The sandbox policy, the working-directory service, and the sandbox providers are unchanged.

The directory is granted only when a Git directory names the Session's directory as a worktree: the `.git` file points at `<common>/worktrees/<name>`, whose `commondir` resolves to `<common>` and whose `gitdir` resolves back to that `.git` file; `<common>` neither contains the Session's directory nor lies inside it; and `<common>` holds `HEAD`, `objects`, and `refs`, the entries Git requires of a Git directory. The pointer files that name the worktree lie in `<common>/worktrees/<name>`, which can be writable without `<common>`: a deployment or another plugin may grant that directory alone. The plugin therefore refuses a layout whose administration directory lies inside a directory the Session's resolved policy already lets it write, unless the result is the Git directory this plugin already granted. Without that rule a writable `<X>/worktrees/<name>` yields a grant of `<X>`, a configured grant of one administration directory widens to the whole Git directory, and a bare repository stored under a directory named `worktrees` lets the Session use its grant to obtain that directory's parent.

The layout is read at Agent creation and after `next()` in the `working-directory/access` waterfall, which every Host move and the validation before each model request pass through. Both callers await the read, so `resolve` stays synchronous and the grant precedes the first operation in the new directory. Every read is complete and replaces the registration, because a registered directory that no longer exists fails every confined operation of the Session. A grant ends in the step that commits a move to another directory, through a prepended `session/event` listener, so no policy combines the entered directory with the Git directory of the one left; the window between that step and the end of the read holds no grant. A read registers nothing once its Agent was disposed, takes its caller's cancellation, and reads each pointer file within a byte cap, since the `.git` file is Session-writable input.

The grant is the whole Git directory. On Windows the plugin registers nothing, since process confinement [ignores additional directories](2026-10-29-windows-file-tool-directory-grants.md).

## Alternatives considered

**Grant only `objects`, `refs`, `logs`, and the worktree's administration directory.** Under the macOS sandbox this admits a commit, a new branch, a tag, and a stash, and denies deleting a packed branch, `git config`, `git remote add`, `git pack-refs`, and `git gc`, which lock files at the top of the Git directory.

**Exclude `hooks` and `config` from the grant.** The registration interface accepts directories and the execution policy has no deny list. Adding one changes the shared sandbox types for one consumer, and a Session in the main checkout can already write both.

**Read once per directory and keep the result.** It saves filesystem round trips in a remote execution world. A Git directory that is removed and restored then stays ungranted, and a result kept across a Host move can describe a layout that changed.

**Derive the grant inside the sandbox policy.** The policy would carry Git worktree knowledge and an asynchronous derivation behind a synchronous `resolve`; the [workspace-root decision](2026-11-03-session-workspace-root.md) removed both.

**Grant only worktrees the Host recorded.** The worktree service's creation and entry records name worktrees no pointer file can forge. A Session opened directly in a linked worktree has no such record and would stay unable to commit, and the plugin would read the records of the service that mounts it.

**Filter grants by the committed directory inside policy resolution.** It removes the window between a committed move and the end of the read without an event listener, and it adds a parameter to the shared registration interface for one consumer.

**Mount the plugin from the base composition.** Every Session started in a linked worktree would receive the grant, also where no worktree capability is selected. The default file permissions of the product would change without a selected capability that needs it.

## Consequences

A Session that works in a linked worktree can write its repository's `hooks` and `config` and the administration directories of the repository's other worktrees; a Git command the user runs outside the sandbox executes those hooks. The package README states this.

A Session whose directory is a subdirectory of a worktree, or a submodule checkout, receives no grant. A command that resolved its policy before a move committed keeps the permissions it resolved, and one that resolves it before the read of the entered directory ends holds no grant, so a Git command issued in the same step as `enter_worktree` can be denied once.

The checks compare the pointer files with what the Session can write now. Files planted while a Session could write more, under `danger-full-access` or from the main checkout before it entered a worktree, pass them, and the grant then reaches a directory that party could already write at the time, such as a subdirectory of the original project a Session left for a worktree.

The forge panel's New worktree option counts the policy's additional writable directories. In a linked checkout the grant therefore makes the option available at the panel's next inspection, and `enter_worktree` creates a worktree there.

Required verification: the real-sandbox suites of the plugin and of the worktree service commit from a worktree without a manual registration and show that a `.git` file naming another worktree's administration directory gains no write access, and that pointer files inside a deployment-granted directory leave its parent unwritable.
