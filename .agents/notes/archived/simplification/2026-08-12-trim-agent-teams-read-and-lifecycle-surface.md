# Agent Note: Trim the Agent Teams read and lifecycle surface

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-trim-agent-teams-read-and-lifecycle-surface.zh.md)

## Problem

Agent Teams correctly owns durable roster, peer-mailbox, and shared-task policy, while the subagent continuation manager owns continuable child Activations. The first implementation nevertheless duplicated data and lifecycle mechanics across those roles.

The read surface published `TeamSnapshot`, including pending mail that no production caller read. Web `team.get` called that snapshot for Team identity and a global revision, discarded its collections, then called `listMembers()` and `listTasks()`; the browser used neither the Team id it had already addressed nor the global revision. Public member and task views also repeated internal fields: member `error` duplicated `diagnostics`, task `ownerId` duplicated the model/UI owner name, and task timestamps had no reader. `SpawnTeammateResult.initialMessageId`, `TeamDeliverySource`, and the public resolved config type likewise had no consumer.

Durable member, task, message, and acknowledgement payloads copied timestamps already owned by the Session event envelope. Message `targetName` repeated the immutable roster lookup. The fold validated these values only against their previous copies, so the extra fields added format and validation code without deciding behavior.

`waitForChange()` returned a zero-or-one `changes` array with a domain kind and Lead-log revision even though every caller immediately re-listed authoritative state. The accompanying `team/changed` event had no production listener. Team interruption bypassed subagent authorization and cancellation semantics by calling `Agent.cancel()` directly. Team teardown separately combined cancellation, descendant drain, `whenIdle()`, and Agent-registry polling even though the continuation manager alone owns Activation release.

## Decision

The Team service keeps the distinct product responsibilities: durable named roster, Lead-log mailbox, and task DAG. It does not merge with the generic subagent catalog or task service.

Inside `@deepseek-ai/dsh-experimental-agent-team`, `TeamService` is the Cordis-facing façade and disposal coordinator. `TeamJournal` owns per-Lead transaction order and append-plus-flush publication; `TeamRoster` owns membership and provisioning; `TeamMailbox` owns target-local dispatch, acknowledgement, and retry state; `TeamTaskBoard` owns task authorization, DAG transitions, and derived views; `TeamActivity` owns current waiters; and `TeamRuntimeLifecycle` owns the single admission cutoff and bounded settlement. These package-private collaborators share the existing service capability without publishing additional Cordis services.

The unused snapshot API and global Team revision are removed. Host reads return only roster and task views; they do not repeat the already-addressed Team id. Member failures appear once in `diagnostics`. Task views expose `ownerName` but keep `ownerId` inside the durable service implementation. Spawn returns the member view only, and validated config is private.

Durable Team values retain only fields needed to replay Team behavior. Session event `seq` and `time` own ordering and timing; roster membership owns immutable names. Member/task/message timestamps, message `targetName`, and acknowledgement `deliveredAt` are removed. Task CAS retains its task-local `revision`, which is behavioral rather than observational metadata.

`waitForChange()` now returns `{ timedOut }`. A committed Team append or live member-status edge wakes current waiters after the owning flush, and callers re-list. The unused `team/changed` event, change kind, change revision, and disposal sentinel are removed.

Team `interrupt()` resolves the durable roster name, then delegates to `SubagentService.interrupt()` with exact ancestor authority. Team teardown selects the roster's exact live direct-child ids and calls the new `drainContinuableChildren(parent, childIds)` continuation operation. That operation authorizes exact direct ownership, opens selected Activation disposal synchronously, recursively releases descendants child-first, leaves siblings and parent-wide admission alone, and treats absent targets as no-ops. Full teardown clears pending inbox work; only interrupt promises `keepInbox`.

Creation and dispatch remain separate in-flight sets because disposal must await creation before dispatches that creation recovery can register. The mailbox's durable enqueue/acknowledgement, target-side de-duplication, FIFO dispatch repair, provisioning reconciliation, and Host fold fallback remain unchanged.

## Alternatives considered

**Merge Team messaging into subagent follow-up.** Rejected. Subagent follow-up addresses a child by Session id and owns Activation delivery; Team messaging adds immutable names, peer authorization, durable enqueue-before-delivery, quiet inactive behavior, acknowledgement, retry, and sender framing.

**Replace Team tasks with the generic task service.** Rejected. The Team board is a Lead-log DAG with CAS revisions, member ownership, dependencies, tombstones, and advisory write scopes. Those are product semantics, not duplicate storage plumbing.

**Keep the public fields for future consumers.** Rejected before the first tagged release. Every removed field lacked a production reader, and pending mail or timing can be projected from the authoritative log if a concrete product later needs them.

**Subscribe to `agent/disposed` from Team teardown.** Rejected. The Team fiber is already unwinding when teardown runs, so new event registration is invalid. More importantly, an observer would still duplicate the continuation manager's ownership instead of asking that owner to release exact children.

**Use `drainContinuableDescendants()` on the Lead.** Rejected because it would stop non-Team continuable children and close admission for the whole Lead lineage. Draining descendants of each teammate stops only grandchildren and leaves the teammate Activation itself to Team polling. The exact-child operation expresses the required set directly.

**Preserve teammate inboxes during full teardown.** Rejected after testing the real handle lifecycle. `AgentHandle.dispose()` is a full release and clears unclaimed inbox work. Describing it as resumable parking would be false; interruption remains the non-disposing operation that preserves pending input.

**Keep all runtime responsibilities in one `TeamService` class.** Rejected because the class would own unrelated task policy, roster provisioning, mailbox delivery queues, waiters, and shutdown settlement. Package-private state owners retain one public service while making each asynchronous set and lifecycle controller belong to the operation family that settles it.

## Testing

Subagent tests cover exact-child selection, duplicate ids, sibling isolation, recursive descendant release, wrong-parent authorization, and a manager-less no-op. Team tests cover delegated interrupt, bounded exact-child teardown, provisioning cleanup, mailbox recovery, wait wake/timeout/disposal, and the reduced views and durable records; white-box failure injection addresses the package-private roster, mailbox, and journal owners instead of widening `TeamService`. Host, tool, and client tests cover the reduced wire and model-visible results. Type checking covers the public deletion across host and browser faces.

## Consequences

Team and subagent remain separate capability seams with one lifecycle owner. Team chooses which roster children belong to its runtime; subagent performs interruption and Activation teardown. The Team surface is smaller, persisted records no longer mirror their Session envelope, and wait consumers cannot mistake an advisory change kind or revision for a coherent snapshot. Package-private state ownership keeps `TeamService` focused on the public operations, Cordis event wiring, recovery order, and disposal order; the split adds internal modules but no public API or durable-format change.

Web `team.get` still folds once for members and once for tasks. A coherent combined snapshot was not a consumer requirement, and adding an incremental cache would introduce a separate consistency mechanism rather than simplify this seam.
