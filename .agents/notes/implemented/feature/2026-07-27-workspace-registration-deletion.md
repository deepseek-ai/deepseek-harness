# Agent Note: Workspace Registration Deletion

Status: implemented

English | [中文](2026-07-27-workspace-registration-deletion.zh.md)

## Problem

A Workspace registers an existing code directory so the GUI can name it and order its Sessions. That record does not say that Harness created or owns the directory, and the Session log is an independent persistence object. Treating the row's Delete action as recursive source deletion or Session deletion would destroy data outside the record's ownership boundary.

The existing visual-only menu row also left deletion semantics undefined across durable order, the Workspace table, Host streams, concurrent browser tabs, reconnect baselines, and a list request racing the mutation.

## Decision

`ctx.workspaceRegistry.delete(id)` deletes only the Workspace registration: its id leaves durable `workspaceIds`, its `workspaces` table row and entity-cache entry disappear, and its ordered `sessionIds` account disappears with that row. It never calls filesystem removal or `SessionPersistence`; the directory, every user file, every live Session, and every persisted Session log remain. Because sidebar grouping is the complement of all surviving Workspace accounts, those Sessions immediately appear under Ungrouped, including the current Session.

Unknown ids return `false` at the domain contract. `workspace.delete({ workspaceId })` maps that distinction to `workspace-not-found`; success returns `{ deleted: true }`. `workspace.list` remains the reconnect baseline.

## Durable commit and publication

Registry operations serialize create and delete. Deletion first writes the Workspace order without the id, then removes the entity from the cache, then deletes the table row. The table deletion is the notification commit point: the package invariant accepts it only after the cache stopped publishing the entity, and the Host emits `host/workspace-removed` only from that committed deletion. A table-write failure restores the cache and prior durable order; no removal frame is published.

The Host stream keeps its committed-id set through the preceding global-order write and removes the id only on the table deletion. Create rollback therefore emits no false removal, while every connected tab receives exactly the id needed to delete its projection.

Create and delete write a durable `pendingMutation` before their record/order pair can diverge. Startup completes only the operation named by that marker and clears it; an orphan row alone does not identify which operation was interrupted. Unmarked order/table divergence therefore retains the registry's fail-loud corruption behavior. A deletion whose table write committed but marker cleanup failed still reports success—the requested state and removal frame are already committed—and the next startup clears that marker idempotently.

## Client convergence

`WorkspaceManager` treats both `host/workspace-changed` and `host/workspace-removed` as ordered deltas replayed over an in-flight `workspace.list` response. A successful unary delete removes the row immediately instead of waiting for its own stream echo. Removal is idempotent, and a process-local tombstone rejects late changed frames or stale baseline rows for the never-reused Workspace id. A reconnect still refreshes from `workspace.list`; Session state is never pruned by a Workspace delta.

The delete confirmation remains pending until the React Workspace projection has committed the removed id, so the next Workspace gesture cannot observe or target one stale list frame.

## Confirmation interaction

The existing Workspace row menu opens a shared `Modal` before deletion. The text states all three consequences: the Workspace leaves the list, the folder and session logs remain, and its Sessions appear under Ungrouped. While the request is pending, the confirm and Cancel controls are disabled, duplicate confirmation is ignored, and Escape or Close cannot dismiss the operation. Failure keeps the Modal open with the error; Cancel, Escape, and Close before submission never delete.

The menu, Modal, and buttons retain their existing structure and design tokens. Session deletion remains visual-only and outside this decision.

## Alternatives considered

**Cascade-delete Sessions.** Rejected because Workspace registration does not own Session persistence and the product requirement is to preserve histories under Ungrouped. Session deletion needs its own lifecycle, running checks, descendant semantics, and explicit UI.

**Move the folder to Trash.** Rejected because the record cannot prove directory ownership. A future destructive filesystem action must be separately named, separately confirmed, and enforce explicit safety boundaries.

**Delete the table row and repair order later.** Rejected because a crash or write failure would leave an initialized registry whose order and table disagree. The registry updates both under one serialized operation and restores the prior order on table failure.

**Delete every unreferenced row at startup.** Rejected because the same shape can come from unexplained order corruption; silently discarding it could lose Workspace metadata and Session accounting. Recovery requires the explicit pending marker written by the owning mutation.

**Refetch both lists after success.** Rejected because the committed removal frame plus immediate unary echo is sufficient, preserves the current Session object, and avoids turning a local mutation into two list requests. Reconnect baselines remain the repair path.

## Verification

Workspace package tests pin successful metadata-only deletion, same-path re-registration, unknown-id idempotence, table-failure rollback, explicit-marker restart recovery, unexplained-corruption rejection, and cache/table invariant behavior. Apiproxy and carrier tests pin the schema, handler, `workspace-not-found`, retained Session/folder, fresh-id re-registration, and committed `host/workspace-removed` frame. Client tests pin unary direct echo, duplicate removal, late changed frames, and deletion racing an in-flight baseline. Component tests pin confirmation, projection-settled closing, success-frame-before-unary ordering, failure, Cancel, Escape, and Close. The browser scenario observes every transient alert, slot error, console error, and page error while reusing a deleted title for a different directory.

The assembled keyless Web scenario registers an existing temporary project directory, accounts a persisted Session, makes that Session current, confirms deletion in Chromium, and verifies the Workspace group disappears while Ungrouped retains the current Session. It checks the user file and JSONL log before and after deletion and repeats the UI, directory, and log assertions after reload. The scenario holds the seeded attachment frame until the browser selects the adoption-created New Session, proves that the seed is absent from the group, then delivers the frame and selects the only non-blank Session. Host attachment completion and a two-row count cannot prove browser membership: the group header plus New Session already satisfy that count, and the arriving seed can replace the positional locator between click and assertion.

## Consequences

Deleting a Workspace is intentionally reversible by registering the same directory again with a fresh id, although its prior manual Session order is gone; re-registration does not automatically re-adopt existing Sessions after bootstrap. The operation gives up a one-click cleanup of Session histories or source directories in exchange for a deletion boundary that matches what the record actually owns.
