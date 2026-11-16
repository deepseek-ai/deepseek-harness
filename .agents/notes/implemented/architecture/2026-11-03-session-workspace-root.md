# Agent Note: Session workspace root

Status: implemented

English | [中文](2026-11-03-session-workspace-root.zh.md)

## Problem

A Session that enters a Git worktree records only a changed current directory. The `working_directory` tool recorded the same event for a model's `cd` into a subdirectory or out of the project, so a consumer could not tell a model-moved cursor from a changed checkout: a file view, a change summary, or a write boundary either followed every `cd` or stayed on the original project. Usage did not justify the cursor: in 58 recorded Sessions of one developer that offered the tool, the model called it once in 6,229 tool calls and prefixed 61% of its shell commands with `cd`.

## Decision

A Session works in one directory, and only Host operations move it. The model-facing `working_directory` tool and the `cwd` parameter of the delegation tools are removed; the model reaches a subdirectory through paths and the shell's per-call `workdir`. `header.cwd` remains the immutable original project: Session identity, workspace grouping, and the recovery destination. `dsh-working-directory` owns the directory and has one read, `get`: relative paths resolve from the directory, and it is the workspace root that consumers bound writes, file views, and discovery by. Every change the service records, through `set` or the recovery of `ensure`, is a `workspace-root/change`.

`workspace-root/change` is a new ordinary event type, recorded as a same-version persistence change in the [acknowledgement](../../../../docs/persistence-changes/2026-11-13-workspace-root-change.md). `working-directory/change` stays in the event vocabulary, deprecated and without a writer. The model could choose the directory of a stored one, so the fold keeps it only when it lies inside the Session's original project: a Session that worked in a worktree or a subdirectory of its project resumes there, with the relative paths its history used. A stored directory outside the project returns the Session to the project, and the next request's context reports the directory. An older build refuses a log that holds `workspace-root/change`; a Session that never moves its workspace holds none.

Worktree creation enters the checkout through `set`. The model has one tool for entering a checkout, `enter_worktree`: a name selects a worktree inside the pool of the checkout the Session works in. An existing one is entered through `ctx.worktrees.enter`, and a new one is created through `ctx.worktrees.create` when none has that name. The name cannot leave that pool, so the model still cannot choose an arbitrary directory. `ctx.worktrees.exit`, exposed as `exit_worktree`, returns the Session from the recorded worktree that contains its directory to the checkout it created or entered that worktree from. A child subagent keeps the parent's original project in its header and starts, through `set`, in the parent's directory or a Host-chosen directory.

## Deferred

The sandbox write boundary, the workspace file service, desktop file drag, the change recorder, and the client file tree, deliverables, open-in-app actions, and Session rows still read `header.cwd`. Until those consumers read the Session's directory, they behave as they did before this decision, and a worktree outside the original project is writable only where the original project's boundary already allows it.

## Alternatives considered

**Keep the cursor and derive the root from registered anchors.** An optional `anchor` on the change, an anchor list, and a longest-containing-anchor rule separate a model's `cd` from a changed checkout, at the cost of three directories, a relocation operation, and an inheritance rule for children. Removing the only model-facing mover makes that separation unnecessary.

**Derive the root from the worktree plugin's creation record.** That record is an ignorable experimental plugin record, which a format migration keeps only on a best-effort basis; a released package must not derive a write boundary from it.

**Rewrite the header on relocation.** The header is identity metadata for storage, grouping, and permission roots; the [working-directory note](2026-09-13-session-working-directory.md) rejected rewriting it.

**An optional `workspace` marker on `working-directory/change`.** Older readers ignore the property and keep reading every log. Every change the service records would then carry a constant, and a missing property would be the only sign of a stored change; a separate event names the workspace move and leaves the stored event unchanged.

**Retire `working-directory/change` through a format migration.** The stored event carries no origin, so a migration would classify each one by its neighbouring events. The containment rule reads stored events as they are. The [compatibility rules](../../../../docs/persistence-changes/README.md#compatibility-rules) reserve a version bump for changes that an existing discriminator cannot make safe.

**Enter a worktree by path.** A model-supplied path would move the write boundary to any registered worktree, which removing the directory tool ruled out unless the user approves each move. A `tools/pre-execute` listener can ask for that approval through the approval service; this decision leaves the path form, and with it entry of a sibling from inside a worktree, to a later change. A name inside the pool keeps the boundary inside the checkout.

**Separate tools for creation and entry.** `create_worktree` beside `enter_worktree` gave the model two tools for one action, entering a worktree, and made it choose by whether the worktree exists. One tool follows Claude Code's `EnterWorktree`, which creates a worktree or opens the one of that name. In the 79 recorded Sessions of one developer that offered `create_worktree`, the model called it once in 6,599 tool calls, so removing the name affects few stored Sessions.

**Persist the shell's `cd` between calls.** That is an implicit cursor. In that developer's Sessions, 68% of `cd` prefixes named a directory outside the Session directory and 30% the Session directory itself, so a persisted directory confined to the workspace would apply to about 2%.

**Two public reads.** `get` for relative paths beside `rootOf` for the workspace root kept every stored directory, and made each consumer choose between two values that are equal in every Session started from this version on. One read with the difference inside the fold removes that choice.

**Keep every stored directory.** Reading every stored `working-directory/change` as the directory needs no rule, but a stored model `cd` to a directory outside the project, such as a home directory, would become the write boundary once consumers follow the directory.

## Consequences

Consumers read one directory through `get`. A stored Session that worked inside its project resumes where it was and follows later Host moves like any other. A stored Session whose log left its project resumes in the project; that includes one opened in a subdirectory of a repository that entered a worktree at the repository root, which `enter_worktree` or another Host move returns to the worktree. A later model-facing cursor needs its own event, because stored `working-directory/change` events are read as the Session's directory. The model enters a checkout only through `enter_worktree`: a new one, or a registered one in the pool. A checkout elsewhere needs a Host operation. The ACP, SDK, and Web producers record the original project by its canonical spelling, so a Host move back to it records no change. The worktree snapshot fixture covers entering, leaving, and losing a worktree. Moving the consumers listed under Deferred is a separate change.
