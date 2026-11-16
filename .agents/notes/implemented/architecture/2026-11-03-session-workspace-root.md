# Agent Note: Session workspace root

Status: implemented

English | [中文](2026-11-03-session-workspace-root.zh.md)

## Problem

A Session that enters a Git worktree records only a changed current directory. The `working_directory` tool recorded the same event for a model's `cd` into a subdirectory or out of the project, so a consumer could not tell a model-moved cursor from a changed checkout: a file view, a change summary, or a write boundary either followed every `cd` or stayed on the original project. Usage did not justify the cursor: in 58 recorded Sessions of one developer that offered the tool, the model called it once in 6,229 tool calls and prefixed 61% of its shell commands with `cd`.

## Decision

A Session works in one directory, and only Host operations move it. The model-facing `working_directory` tool and the `cwd` parameter of the delegation tools are removed; the model reaches a subdirectory through paths and the shell's per-call `workdir`. `header.cwd` remains the immutable original project: Session identity, workspace grouping, and the recovery destination. `dsh-working-directory` owns the directory. Every change it records, through `set` or the recovery of `ensure`, is a `workspace-root/change`, and the `workspaceRoot` projection is the directory of the last one, or the original project before any. `rootOf` therefore equals `get` in every Session started from this version on.

`workspace-root/change` is a new ordinary event type, recorded as a same-version persistence change in the [acknowledgement](../../../../docs/persistence-changes/2026-11-13-workspace-root-change.md). `working-directory/change` stays in the event vocabulary, deprecated and without a writer. A stored one, written while the model could move the directory, moves only the current directory, so a stored Session keeps the root it had. An older build refuses a log that holds `workspace-root/change`; a Session that never moves its workspace holds none.

Worktree creation enters the checkout through `set`. The model has one tool for entering a checkout, `enter_worktree`: a name selects a worktree inside the pool of the checkout the Session works in. An existing one is entered through `ctx.worktrees.enter`, and a new one is created through `ctx.worktrees.create` when none has that name. The name cannot leave that pool, so the model still cannot choose an arbitrary directory. `ctx.worktrees.exit`, exposed as `exit_worktree`, returns the Session from the recorded worktree that contains its directory to the checkout it created or entered that worktree from. A child subagent keeps the parent's original project in its header and starts, through `set`, in the parent's workspace root or a Host-chosen directory.

The consumers divide by who perceives the directory. The model's file, search, and process tools resolve relative paths from the current directory. Everything the user sees or that describes the project reads the workspace root: the sandbox `workspace-write` boundary, the workspace file service and desktop file drag, the change recorder, the Files tree, deliverables, open-in-app actions and Session rows, new sidebar terminals, `@` file candidates, the skill catalog, project-instruction discovery, and the LSP workspace. The two are one directory except in a Session that holds `working-directory/change` events.

The sandbox policy derives the common directory of a linked checkout from the root's `.git` pointer through the execution-world filesystem and adds it to the resolved extra writable roots, accepting only the layout Git writes: `<common>/worktrees/<name>` with a `commondir` naming `<common>` and a `gitdir` naming the checkout's `.git`, since the checkout's own pointer is writable under `workspace-write`. A root's result is kept once read and refreshed when a Host operation moves a Session's workspace to that root or a derived directory disappears; tool executions wait for the derivation, Session creation and directory changes start it early, and the derived directories stay out of the model-visible policy text. On Windows the derived directories follow the [file-tool grant decision](2026-10-29-windows-file-tool-directory-grants.md): `write` and `edit` honor them, and process confinement keeps its workspace and private-temp grants. After a move into a worktree the original project is writable only through the Git administration directories, not as a whole. Host maintenance of a checkout the Session does not work in keeps the original boundary: removing a worktree on archive, restoring a removed one, and reading its branch in the source repository run under the Session's policy with the recorded source checkout as the root, requested through `resolve({ session, root })`; the Session's own root may be the removed directory, and a process sandbox cannot bind a missing or vanishing root.

## Alternatives considered

**Keep the cursor and derive the root from registered anchors.** An optional `anchor` on the change, an anchor list, and a longest-containing-anchor rule separate a model's `cd` from a changed checkout, at the cost of three directories, a relocation operation, and an inheritance rule for children. Removing the only model-facing mover makes that separation unnecessary.

**Derive the root from the worktree plugin's creation record.** That record is an ignorable experimental plugin record, which a format migration keeps only on a best-effort basis; a released package must not derive a write boundary from it.

**Rewrite the header on relocation.** The header is identity metadata for storage, grouping, and permission roots; the [working-directory note](2026-09-13-session-working-directory.md) rejected rewriting it.

**An optional `workspace` marker on `working-directory/change`.** Older readers ignore the property and keep reading every log. Every change the service records would then carry a constant, and a missing property would be the only sign of a stored change; a separate event names the workspace move and leaves the stored event unchanged.

**Retire `working-directory/change` through a format migration.** The stored event carries no origin, so a migration would classify each one by its neighbouring events, and a stored model `cd` still needs a record that moves only the directory. The [compatibility rules](../../../../docs/persistence-changes/README.md#compatibility-rules) reserve a version bump for changes that an existing discriminator cannot make safe.

**Enter a worktree by path.** A model-supplied path would move the write boundary to any registered worktree, which removing the directory tool ruled out unless the user approves each move. A `tools/pre-execute` listener can ask for that approval through the approval service; this decision leaves the path form, and with it entry of a sibling from inside a worktree, to a later change. A name inside the pool keeps the boundary inside the checkout.

**Separate tools for creation and entry.** `create_worktree` beside `enter_worktree` gave the model two tools for one action, entering a worktree, and made it choose by whether the worktree exists. One tool follows Claude Code's `EnterWorktree`, which creates a worktree or opens the one of that name. In the 79 recorded Sessions of one developer that offered `create_worktree`, the model called it once in 6,599 tool calls, so removing the name affects few stored Sessions.

**Persist the shell's `cd` between calls.** That is an implicit cursor. In that developer's Sessions, 68% of `cd` prefixes named a directory outside the Session directory and 30% the Session directory itself, so a persisted directory confined to the workspace would apply to about 2%.

**Read stored changes as workspace moves.** A stored model `cd` would narrow or move the write boundary of an existing Session; a log that lacks a feature keeps its old behavior.

## Consequences

Consumers read one directory: `get` for relative paths and `rootOf` for everything that belongs to the workspace. The two differ only in a Session that holds `working-directory/change` events, and the next Host move brings them together. Readers keep folding that event as a directory-only change, so a later cursor needs no format change. The model enters a checkout only through `enter_worktree`: a new one, or a registered one in the pool. A checkout elsewhere needs a Host operation. The ACP, SDK, and Web producers record the original project by its canonical spelling, so a Host move back to it records no change. A Session opened inside a linked worktree can run `git commit` under `workspace-write`, and the shared `.git`, including its hooks and configuration, is writable from that Session as it already is from a Session in the main checkout. An SDK `setWorkingDirectory` call and a child started in a Host-chosen directory move the `workspace-write` boundary with the directory. The worktree snapshot fixture covers entering, leaving, and losing a worktree.
