# Agent Note: Workspace UI Complete Product Flow

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-25-workspace-ui-product-flow.zh.md)

## Problem

[Domain KV Storage and the Workspace Entity](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) defines the persistent Workspace entity, path conventions, and ordered Session ledger, but not the Host wiring, historical-data initialization, or GUI flow. The GUI presents both Workspaces and Sessions; users must be able to type immediately after entering New Session, even when no Host Session or Host Workspace exists yet.

Pending Workspaces, pending Sessions, retained input, and Host entity publication need clear owners and must preserve the same page identity when RPC completions and Host frames arrive in either order. Eagerly creating a Host Session for the zero state would bring a page with no input into the Host lifecycle. Historical Sessions also expose only the lightweight `SessionHeader.cwd` for grouping; initialization cannot read event bodies.

## Decision

### Host and persistent data

The Host provides the following GUI wiring on the Workspace entity:

| RPC | Behavior |
| --- | --- |
| `workspace.list` | Returns persistent Workspaces in order and filters out Session ids that fail header validation |
| `workspace.create({ path })` | Adopts an existing directory by canonical path; basename-derived display titles may repeat |
| `workspace.insertBefore({ workspaceId, beforeWorkspaceId? })` | Moves one Workspace within durable registry order and returns the complete committed order |
| `workspace.delete({ workspaceId })` | Removes the Workspace registration while retaining its directory and session logs; its Sessions become Ungrouped |
| `session.create({ workspaceId, sessionId? })` | Resolves cwd from the Workspace, idempotently creates a Session with an optional preallocated id, and attaches it |
| `session.create({ cwd })` | Remains available to non-Workspace callers and creates an Ungrouped Session |

The Host stream pushes Workspace and Session deltas, including `host/workspace-removed`, and the Client refreshes the `workspace.list` and `session.list` baselines separately after reconnecting. Registration-deletion ownership and safety are defined in the [Workspace registration deletion Agent Note](2026-07-27-workspace-registration-deletion.md).

A Workspace's `sessionIds` is an ordered candidate index. A membership projection requires both that an id appear in the index and that the corresponding canonicalized `SessionHeader.cwd` equal the Workspace path; SessionHeader does not gain a `workspaceId`. A Session whose cwd matches but whose id is absent from the index remains Ungrouped, while an indexed id is filtered out if its header is missing, its cwd is invalid, or its cwd does not match. Two Workspace indexes claiming the same Session is corrupt state and fails loudly.

The Workspace domain uses a durable marker to distinguish “never initialized” from “initialized but empty.” When the marker is absent, the Registry calls only `SessionPersistence.list()` to read header metadata; it calls neither `load` nor `inspect`, reads no history, and parses no event bodies. Valid cwd values are grouped by canonical path, and both Sessions within each group and the Workspace groups themselves are initialized in descending header `createdAt` order. Bootstrap is reentrant and writes the marker last; after the marker is written, new Sessions created without `workspaceId` are no longer adopted automatically.

### Client object model

`Session` and `Workspace` are frontend objects from the page Intent stage onward.

- A frontend Session preallocates a SessionId when created and owns its Intent target and `pendingPrompt`; it remains the same Session object after Host `session.create` succeeds.
- Before materialization, a frontend Workspace has no WorkspaceId and owns its create input, phase, and error; after Host `workspace.create` succeeds, the same Workspace object adopts the returned view.
- `SessionManager` and `WorkspaceManager` own object indexes and merge Host baselines and deltas; the objects are the sole source of state for both Intents and Host views.
- `SessionRuntime` provides Session objects, real selection, scope, and list projections; `WorkspaceRuntime` depends on `SessionRuntime` and owns the default Workspace, cross-object New Session flow, and Workspace materialization.

A page has at most one frontend Session Intent and one accompanying Workspace Intent that exists only in the zero-Workspace state. Intents exist only on the current page and disappear on refresh; real Session selection can be restored persistently. Selecting a real Session or starting another Session Intent revokes the old Intent's eligibility for automatic sending, but does not roll back a Session already published by the Host or any accepted message.

The Session owns the first input and drives one internal pipeline: when necessary, it attaches to a Workspace with its preallocated id, then sends `pendingPrompt`. Both attach and send failures return to the same Session. Workspace creation phase and error belong only to the Workspace object; the Session does not simulate the Workspace lifecycle.

### User flow

On initial entry, the application waits until both the Workspace and Session baselines are ready. It restores a real Session selection that remains valid; otherwise, it enters New Session and selects the most recent Workspace exactly once. The most recent Workspace is determined by the maximum `updatedAt` of its member Sessions, falling back to `createdAt` for an empty Workspace. This derived value chooses only the default target: it does not alter the Host Workspace order or trigger another selection after later hydration.

When no Workspace exists, the page creates a frontend Workspace object named `workspace` and a frontend Session that targets it. Neither writes to the Host, and the composer always accepts input; the first send materializes the Workspace, attaches the Session, and sends the message in that order.

Top-level New Session, the plus button on a Workspace row, and the Workspace picker all invoke the same New Session action. An explicit Workspace id becomes the target directly; when none is specified, the action uses the current Session's Workspace, then the most recent Workspace, and enters the blank New Session page when no real Workspace exists. The Workspace picker's one Add workspace action ([one-route Note](../simplification/2026-07-31-one-route-to-add-a-workspace.md); it was a pair of Use-an-existing-folder and create-by-name actions when this was decided) immediately creates a real Workspace when the user confirms a directory, then retargets the frontend Session to it; an explicitly created empty Workspace remains even if the user sends no message.

A new Workspace takes its display name from the directory it was created in. Distinct canonical paths may share the same basename-derived title ([identity decision](../bug-fix/2026-07-31-same-basename-workspace-adoption.md)); the explicit rename operation retains its duplicate-title check. Moving Sessions across Workspaces, manual adoption from Ungrouped, and separate display-name and directory-name inputs remain outside this flow.

### First send and recovery

A frontend Session's `pendingPrompt` retains its original text until the Host accepts the message. The first send advances through Workspace materialization, Session attachment, and prompt sending in order:

1. If Workspace creation fails, the Workspace Intent retains its input and error, and the Session continues to target that object.
2. If Session creation fails before publication, the Session Intent returns to an editable state and retries with the same preallocated SessionId.
3. `workspace-attach-failed` proves that the Session has been published; the same Session object enters the real list and retains the prompt, and subsequent retries attach it.
4. If the prompt fails, the Session retains it and retries only send without recreating the Workspace or Session.
5. If the page switches to another Intent while a Session is being created, the old Session does not send automatically even if it is subsequently published; it retains its original prompt and visible error.

Lost RPC responses, Host frames arriving before completions, and completions arriving before Host frames all converge through the preallocated SessionId and object identity. The Manager performs ordered upserts of Host views and prioritizes preserving the original object identity during local materialization, rather than creating a temporary second row with the same id.

### Sidebar and ordering

Workspace groups follow the persistent order returned by the Host. Bootstrap determines the historical order once, explicitly created Workspaces are placed first, and `workspace.insertBefore` durably applies user drag order. Session activity does not move Workspace groups.

The Host account remains the manual `Workspace.sessionIds` order: a newly attached Session is placed first and activity does not mutate it. The grouped browser can instead select a browser-local recent-update view that promotes a Session when its `updatedAt` advances and remains manually editable. Five Sessions are visible per open Workspace until the user transiently expands the remainder. The durable Workspace reorder and browser-local Session order are defined in [Workspace Sidebar Order and Folding](2026-08-11-workspace-sidebar-order-and-folding.md).

The current blank Session appears as a “New session” row without a count, time label, or row menu; other blank Sessions remain hidden and eligible for per-Workspace reuse. Search excludes blank rows.

Real Sessions that cannot be assigned to any Workspace appear under Ungrouped. Host `session-added` and `workspace-changed` events may arrive in either order; list merging does not depend on frame order.

Deleting a Workspace registration removes its group without deleting or closing any Session. Its accounted Sessions immediately join Ungrouped, including the current Session; a reload reconstructs the same result from the independent Workspace and Session baselines.

### React and slot boundaries

React components only consume `useSessions`, `useWorkspaces`, and session-scoped hooks; they do not own entity lifecycles. The Zustand store retains only layout, the current view, composer text for ordinary real Sessions, and other purely presentational state. Session and Workspace Intents, materialization phases, errors, and retained prompts reside in the React-free runtime object layer.

The Sidebar and conversation empty hero receive standardized actions through slots: `startSession`, `updateSessionPrompt`, `sendSession`, `open`, and `toggleSidebar`. The Workspace picker reuses the same component and the `createWorkspace` action; its owner supplies only popover state, an anchor, and a selection callback. The presentation layer does not send `host/workspace-changed` directly; Host events originate only from Host mutations and the stream adapter.

## Alternatives considered

**Store separate page records for pending Workspaces and Sessions.** This approach must replace identities after materialization and hand off input, errors, focus, and sidebar rows; Intent state owned by the objects preserves identity continuity.

**Let the presentation layer or root Zustand store orchestrate object lifecycles.** This approach duplicates Manager and Service responsibilities and brings domain state back into React. Runtime services provide standardized actions, while slots inject only the narrow interfaces required by presentation.

**Immediately create a Host Session or Host persistence intent in the zero state.** A page with no input would enter the Host lifecycle and change refresh semantics; before the first send, the frontend Session retains only a page-local Intent.

**Delay an explicit Create Workspace until the first send.** After confirmation, the sidebar would still show no real empty Workspace, conflating “create a Workspace” with “prepare a Session”; only the zero-Workspace Intent generated automatically by the system delays materialization.

**Continuously derive Workspaces dynamically from cwd.** This cannot represent empty Workspaces, stable display names, or explicit ordering, and would automatically adopt non-Workspace callers; cwd is used only for one historical bootstrap and bidirectional membership validation.

**Have the Client batch-reorder by time after the Session list arrives.** The initial screen would first show the Host order and then jump as a whole, and reconnecting could change positions again; the Host's persistent ledger owns ordering, while the Client merges only individual updates.

**Add workspaceId to SessionHeader.** This would create two persistent ownership fields alongside the Workspace index and require double writes; the header retains the Session's own cwd fact, while the Workspace index owns explicit membership.

## Verification

- The zero state with no Workspace writes nothing to the Host and accepts input; explicit Create Workspace immediately creates and displays an empty Workspace.
- Frontend Sessions and Workspaces preserve object identity across materialization; input, errors, focus, and sidebar projections always originate from the object layer.
- The first send advances through Workspace, Session, and prompt in order; successful stages are not rolled back, input is not lost before the prompt is accepted, and creation retries use the same SessionId.
- Workspace list performs one reentrant bootstrap using only headers; an initialized empty registry does not initialize again after restart, and membership reads validate both the index and canonical cwd.
- The initial default target is determined exactly once after both baselines are ready; Workspace groups are not reordered by hydration or Session activity, and explicit Workspace drag order survives reconnect.
- The current blank Session can appear as a single New Session row without exposing other reusable blanks or a Session count.
- The UI and Host admit distinct same-basename directories as separate Workspaces, while the explicit rename operation rejects duplicate titles; cwd-only Sessions, Sessions with invalid historical cwd values, and unattached Sessions remain Ungrouped.
- Confirmed Workspace deletion removes only the registration, retains the current Session, directory, files, and session log, and survives reload; package tests pin unary/frame/baseline races and failure rollback.
- Keyless runnable snapshots cover the zero state, explicit creation, and the first send; package-level tests cover bootstrap, membership validation, ordering, idempotency, failure recovery, and arbitrary frame order.

## Consequences

- SessionHeader does not record last-active time, so historical bootstrap can initialize the Host manual order only by `createdAt`; the browser's optional recent-update view begins from Session summaries after hydration.
- Historical Sessions with a missing cwd, an invalid directory, or a failed realpath remain Ungrouped; this iteration has no manual-adoption entry point.
- Refreshing the page discards unmaterialized Workspace and Session Intents and input not yet accepted by the Host; this is the page-local contract.
- Explicit Create Workspace writes to disk immediately, so leaving without sending still leaves an empty Workspace.
- Before its first event, a Host Session retains the existing lazy-persistence semantics; frontend Intents do not change empty-Session behavior after a Host restart.
