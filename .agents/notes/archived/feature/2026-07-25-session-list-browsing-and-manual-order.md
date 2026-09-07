# Agent Note: Session List Browsing and Manual Workspace Order

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-25-session-list-browsing-and-manual-order.zh.md)

## Problem

[Workspace UI Complete Product Flow](2026-07-25-workspace-ui-product-flow.md) shipped the first form of the grouped session list and explicitly scoped out operations such as Rename and drag ordering. The design file (figma 239-10458 and its companion screens) has since filled in those interactions: the list must switch to an ungrouped flat view, session rows need a hover detail card and an action menu, workspaces need renaming, and sessions need manual ordering inside their group.

Two existing mechanisms stood in the way. First, the host durably promoted the active session to the front of its workspace account on every `session/event` (activity pinning), so any manual order would be scrambled by the next activity — two ordering authorities cannot coexist. Second, the browsing area was split across two packages: ui-sidebar owned the list, search, and header rows while ui-workspace only borrowed a picker slot for its popover; every new workspace-domain dialog required cross-package wiring, and ownership grew more twisted with each one.

## Decision

### Flat rows and viewing state

The group-by menu offers two modes, WorkSpace / In one list. WorkSpace mode renders peer session rows within each group in the manual order from `WorkspaceView.sessionIds`; In one list combines every session and sorts them strictly newest-first by `updatedAt`. Neither mode projects `parentId` into a list hierarchy; fork lineage remains session data only. [Web session fork actions](2026-07-27-web-session-fork-actions.md) define the complete fork behavior. The mode choice persists in the browser (`dsh.workspace.view`) across reloads. [Workspace Sidebar Order and Folding](2026-08-11-workspace-sidebar-order-and-folding.md) later added a browser-local recent-update view without changing the Host account's manual-order authority.

### Row interactions

- Session rows show a detail card after a 500ms hover dwell (full title / relative time / status line; the status line has only running/idle until the wire grows a status field). The card and the row menu are mutually exclusive: no card while a menu is open or a drag is in flight.
- Session-row … menu: Rename / Fork session / Delete session; Rename and Fork are wired, while Delete remains visual-only. The workspace-header … menu's Rename / Delete workspace actions are both wired. Menus close when the pointer leaves them.
- Supporting primitives: `Menu` gains label entries, danger rows, and `closeOnPointerLeave`; a new `HoverCard` (portaled placement, open delay, disabled guard).

### workspace.rename

`workspace.rename({ workspaceId, title })`: the title is trimmed and must be non-blank; both the same-title no-op and the duplicate check evaluate inside the Host's serialized workspace-operation chain (shared with path adoption and deletion, so concurrent workspace operations cannot interleave a duplicate or an out-of-order fake success), and a conflict returns `workspace-name-conflict`. Path adoption may derive a title already present because canonical path, not title, owns identity ([decision](../bug-fix/2026-07-31-same-basename-workspace-adoption.md)). Durability goes through `setTitle`'s mutate path, and the `domain/changed` listener broadcasts the `host/workspace-changed` frame automatically. The UI is a standard modal with a client-side duplicate pre-check.

### Manual order: insertSessionBefore replaces activity pinning

The `session/event` → `touchSession` activity-pinning chain is deleted wholesale; the workspace account order is now manually owned — new sessions prepend at attach, and explicit reordering goes through `workspace.insertSessionBefore({ workspaceId, sessionId, beforeSessionId? })` (DOM insertBefore semantics: with an anchor it inserts before it, omitted appends to the end). The entity throws a typed `WorkspaceMoveInvalidError` only for unaccounted session/anchor ids; the handler maps exactly that to the business code `workspace-move-invalid`, while storage failures stay internal.

The UI is HTML5 drag on session rows inside a group (workspace grouping only, outside search; fork children and their source sessions are ordered independently). Order authority stays entirely host-side: drop only sends the RPC, the client performs zero local reordering, and the view refreshes from the response upsert and the changed frame; a failed move changes nothing. The client's upsert rejects snapshots older (`updatedAt`) than the installed projection so a late unary response cannot roll back a newer frame.

### Shell/region split

ui-sidebar shrinks to the column-geometry shell: brand row, fold state machine, New Session, Settings, and one `sidebar.workspaces` hole; the shell↔region contract is two facts, `{ wide, expandSidebar }`. ui-workspace fully owns the browsing region (section header, search, grouped tree and flat list, every workspace dialog, drag) plus its groupBy store; the rail-state search/add-workspace icons belong to the region too and request shell expansion via `expandSidebar()`. The picker splits into the core `WorkspacePickFlow` (composed directly inside the region; named `WorkspaceCreateFlow` until the [one-route Note](../simplification/2026-07-31-one-route-to-add-a-workspace.md)) and the thin `WorkspacePicker` wrapper (still filling ui-conversation's hero slot); the old `sidebar.workspace` picker slot and its declaration-aware deferral are deleted with it.

## Alternatives considered

**Keep activity pinning; treat drag as a transient adjustment** — the manual order would be scrambled by the next session activity, making it a fiction; two coexisting ordering authorities cannot be explained to the user. A middle ground — freeze pinning per workspace after the first drag — adds a state tier with murkier semantics; deleting outright is cleaner.

**Numeric index in the reorder payload** — `{ index }` drifts during the drag window: after the host prepends a new session (e.g. Intent materialization) the same index points at a different row. Anchor-style insertBefore is naturally immune to prepends and filtered projections.

**Optimistic reordering on drop** — client-first reordering needs failure rollback, one more entangled state in the object layer; local/LAN round-trips are millisecond-scale, so waiting for the host response is imperceptible. With a single order authority (trust the host completely), the frontend never invents an order.

**Keep the rename dialog in ui-sidebar (smallest change)** — that is the problem itself: workspace-domain dialogs scattered in a borrowed slot, with each addition (the Delete confirmation is coming) repeating the cross-package wiring. Moving only the rename modal would repeat that wiring on the next dialog; the whole browsing region goes to ui-workspace and the shell stays geometry-only.

**Nest sessions by fork lineage in WorkSpace mode** — nesting makes the current child visible only while its ancestors are expanded and limits in-group manual ordering to root nodes; `parentId` is lineage data, not a list-navigation structure. Flattening all sessions into peer rows lets each row be opened, searched, and ordered independently; In one list still disables drag because it has no workspace persistence carrier.

## Consequences

- Manual order is the sole authority over the Host workspace account: activity never mutates `WorkspaceView.sessionIds`. A later browser-local recent-update view may promote active rows without changing that account; its separate semantics are defined in [Workspace Sidebar Order and Folding](2026-08-11-workspace-sidebar-order-and-folding.md).
- The two-fact shell/region contract funnels every future workspace-domain feature (Delete confirmation, cross-group moves, Ungrouped adoption) into the single ui-workspace package; ui-sidebar no longer evolves with session-list features.
- Flat mode supports neither reordering nor a create-in-workspace entry point (switching back to grouped view is required) — an accepted scope reduction.
- Wiring session Delete and growing the wire status enum remain future iterations.

## Testing

Package-level suites cover the derivations (deriveGroups/deriveFlat), peer session rows, both apply registrations and passthroughs, host entity move semantics, and the rename/insertSessionBefore RPC implementations with their fixture stubs; the `apps/web` keyless snapshots regress the assembled application and pin that a fork does not introduce session expansion controls.
