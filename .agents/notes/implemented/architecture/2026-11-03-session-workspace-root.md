# Agent Note: Session workspace root

Status: implemented

English | [中文](2026-11-03-session-workspace-root.zh.md)

## Problem

A Session that enters a Git worktree records only a changed current directory. The same event records an ordinary `cd` into a subdirectory, so a consumer cannot tell a moved cursor from a changed checkout: a file view, a change summary, or a write boundary either follows every `cd` or stays on the original project. The original project is the only directory the header records, and a Session opened inside a linked worktree records nothing about the checkout it is in. Peer products that support entering another checkout in one conversation keep an immutable session origin and record each relocation as an event, and they separate the shell cursor from the checkout it is in.

## Decision

Each Session has three directories with one owner each. `header.cwd` remains the immutable original project: Session identity, workspace grouping, and the recovery destination. `dsh-working-directory` owns the other two. The current directory is the cursor relative paths resolve from; its `workingDirectory` projection and `set` are unchanged. The workspace root is the checkout that cursor is in; the `workspaceRoot` projection folds it from the same `working-directory/change` events as the longest registered anchor containing the current directory. The anchors are the original project and every checkout `relocate(agent, root, { cwd? })` entered.

`relocate` validates the root and the directory inside it, then commits one `working-directory/change` whose optional `anchor` names the root. A `set` inside the root moves only the cursor; a `set` into another anchor selects that anchor as the root; a `set` outside every anchor moves the cursor and leaves the root. Recovery to the original project selects it again. The event's optional property is a same-version persistence change recorded in the [acknowledgement](../../../../docs/persistence-changes/2026-11-03-working-directory-anchor.md); a log without `anchor` folds to the original project as its only anchor.

Worktree creation enters the checkout through `relocate`; leaving it is the existing `set` back into the original project, which the anchor rule turns into a root change. A child subagent keeps the parent's original project in its header and starts its directories through the service's `inherit`, which owns the decision: when the parent's root is another registered checkout and the child starts inside it, the child relocates into that root; otherwise only its directory is set. The child's root is then that checkout unless the original project its header registers already contains the child's directory, because the root is always the longest containing anchor; the child registers no other parent anchor, so a later `cd` into another checkout the parent entered leaves the child's root unchanged. The user-context snapshot adds a `Workspace root` line while the cursor differs from the root, and a change notice ends with the new root when the change selects another root. The SDK working-directory methods return `{ cwd, root }`, and `getWorkspaceRoot` (`get_workspace_root` in Python) reads the root.

## Deferred

The sandbox write boundary, the workspace file service, desktop file drag, the change recorder, and the client file tree, deliverables, open-in-app actions, and Session rows still read `header.cwd`. The sidebar terminal, `@` file candidates, the skill catalog, project-instruction discovery, and the LSP workspace still read the current directory although they belong to the root. Until those consumers move, they behave as they did before this decision, and a worktree outside the original project is writable only where the original project's boundary already allows it.

## Alternatives considered

**Rewrite the header on relocation.** The header is identity metadata for storage, grouping, and permission roots; the [working-directory note](2026-09-13-session-working-directory.md) rejected rewriting it, and every peer product keeps an immutable origin.

**A new event type for relocation.** Adding an ordinary event type is also same-version, but an older reader refuses to reconstruct a log holding an unknown required event, so a Session that entered a worktree would not open there. An optional property on the existing event leaves older readers with the current directory they already understood.

**Let the root follow every `cd`.** A `cd` into `packages/foo` would re-root the file tree and shrink the write boundary to that subdirectory while the user still works on the same project.

**Derive the root from Git at read time.** The directory service would need Git and filesystem I/O inside a projection; anchors and lexical containment are pure and deterministic over the log.

**One new Session per worktree, never a relocation.** The model-facing worktree tool already continues one Session in the new checkout; forge's new-Session worktree path and that tool both resolve to the same relocation.

## Consequences

Consumers can ask the directory service three questions with three answers: where the Session started, which checkout it works in, and where relative paths resolve. Existing logs change meaning for no reader: they hold no anchor, so the root is the original project. Anchors compare lexically, so the ACP, SDK, and Web producers record the original project by its canonical spelling, a Session without a recorded project registers the deployment fallback as its first anchor on first validation or relocation, and a recovery destination no anchor contains joins the anchors. A header recorded by another spelling before that change keeps the previous root after a `cd` back into the original project until recovery registers the canonical destination. The worktree snapshot fixture and the directory notices carry the root text. Moving the consumers listed under Deferred is a separate change.
