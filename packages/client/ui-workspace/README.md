---
description: "Shared Workspace browser and picker plugin for the dsh web client: grouped or flat session rows, add/rename/reorder, search, fork, archive, and the directory-flow picking hole."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace

English | [中文](README.zh.md)

## Summary

This package lets users browse grouped or flat Session lists, choose a Workspace for a new Session, and manage Workspaces and Sessions through add, rename, reorder, search, fork, archive, and Workspace deletion. Pending interactions appear as warning dots, active scheduled tasks as alarm markers, and subagent-origin Sessions remain hidden. Canonically distinct folder paths remain separate Workspaces. Adding a Workspace requires a composed directory picker; without one, the add action is unavailable.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the sidebar to browse Workspaces and their Sessions, reorder them, and start new ones; use the picker in the Session Intent hero to choose a Workspace for a new session. An open Workspace shows five non-blank Sessions by default and keeps the selected blank **New Session** as one provisional extra row until its first prompt. **Show more** reveals the hidden remainder; closing and reopening the Workspace restores this folded projection.

### Reordering and view options

**Last updated** orders ordinary Sessions by their latest user prompt or steer time, newest first, in both grouped and flat views. **Manual** freezes the current displayed order and holds positions when activity changes; newly discovered ordinary Sessions append to the end, newest first when several arrive together. Returning to Last updated discards every manual position, and entering Manual again freezes the then-current recency order. The browser defaults to Last updated and remembers the selected mode across reloads. Dragging an ordinary Session applies the move locally and selects Manual. The selected blank **New Session** is always pinned first and cannot be dragged; after its first prompt it becomes an ordinary draggable row, retaining its first position in Manual or following its current timestamp in Last updated. In a collapsed group, drag boundaries follow rendered rows and place the source before intervening hidden rows, so a drag cannot hide its source. Session display orders for real Workspaces, Ungrouped, and the flat list are browser-local; Workspace group drag order remains Host-durable.

### Search

Collapsed search is one header action beside the view and add actions: activating it expands the field across the header. A non-blank query replaces either browsing mode with one flat result list — case-insensitive title and Workspace substring matches appear immediately, while a 250 ms debounced Host request adds ranked current-conversation content matches and snippets. Each new query aborts the preceding request; a failed content search leaves metadata matches visible with a warning. The list is capped at 20. Choosing a result clears and collapses search, opens the Session, and scrolls its row into view in the configured browsing mode; grouped browsing also expands its Workspace and the full Session list when required.

### Managing sessions

The Session row's Rename action opens a dialog prefilled with the row's display title; confirming an unchanged title is deliberately allowed — it pins the current automatic title against regeneration. Archive commits without a confirmation dialog and the row disappears from every grouping surface when the archive-set echo lands. Fork forks at the source's last completed turn, increments the inherited persisted title on the client, and then opens the child. Workspace Delete opens a confirmation that states the retention boundary; success removes the group while its Sessions remain under Ungrouped.

### Pending interactions

Session rows render the runtime's live `pendingInteraction` classification: approvals report **Waiting for approval**, plan reviews report **Plan awaiting review**, and ordinary questions report **Waiting for answer**. Every pending interaction uses an amber warning dot that takes precedence over the running indicator.

### Active Schedule markers

Grouped and flat Session rows, plus search results, show an outline alarm when `SessionSummary.projectionValues.schedule` is a non-empty array. The marker sits after the title; an ordinary row keeps its update time after the marker, while a search result has no update time. It is not a button, has no independent pointer action or tab stop, and clicking its area still opens the row. The localized tooltip and matching screen-reader label say **Has active scheduled task**.

The value is intentionally best effort for cold Sessions. An identity-matching usable projection-cache row can prewarm the alarm without opening the Session; a missing or stale cache may briefly omit or retain it. The marker means only that the current list value contains an undispatched or undeleted Schedule record. It does not report whether a Schedule runtime is live or able to wake the Session.

-----

`ctx.uiWorkspace.openSession(id)` selects the Session and returns the main area to the Conversation as one UI navigation action, including when that Session was already current. `openWorkspace(id, beforeOpen?)` and `forkSession(id)` open their result only if no later navigation has superseded the request; New Session uses `openWorkspace`. The optional synchronous preparation callback runs only for a current Workspace request, so superseded requests do not move composer drafts. Navigation or owner disposal suppresses the late UI commit, not the underlying Session creation. Selection failure leaves a global panel visible. Session rows read `usePanelInfo` to suppress their selected appearance while a global panel is active; search and directory-picker focus alone do not leave that panel.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one composition: both target slots are declared by other plugins, so `apply` uses `slots.inject()` to register for each declaration lifetime and re-register after a declaring slot is restored.

### The directory-flow hole

Each registration declares a **directory-flow child hole** (`single` kind: `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`) that the composed picker package's client half fills with its picking interaction — the `-native` backend's renderless OS-chooser driver, an in-app browsing dialog under a `-browse` composition. The flat **Add workspace...** action renders only while the surface's hole is occupied; an empty hole means the composition has no picking affordance. This package owns the trigger and the adoption: the occupant reports one picked path per open through the hole's owner conversation (`open`/`busy`/`onPicked`/`onCancel`/`onError`), and the owner adopts it through the object layer, selecting the committed Workspace only after its list projection has refreshed.

### View state

Once the Workspace list baseline is ready, browser-persisted expansion and manual Session-order records retain only current Workspace ids plus Ungrouped and the flat-list account. `WorkspaceView.sessionIds` supplies real-Workspace membership, not Session display order. View actions require the current account orders explicitly. Flat-list membership and ordering use Session ids; row rendering adds status indicators once. Entering Manual snapshots every active account from the current display; reconciliation retains saved members that still belong to the account, removes departed members, and appends newly known members by recency. A new membership entry without a Session summary is omitted until that summary arrives, while an already saved slot survives a temporarily missing summary. During Workspace reconnection, Manual records an observed blank Session at the front of its saved flat and known group orders without removing other saved members; full membership reconciliation waits for the Workspace baseline. This reconciliation remains mounted while the sidebar is a rail or search replaces its body. Last updated derives directly from each current list snapshot without reading or writing saved positions; equal timestamps use Session ids as a stable tie-break. The shared sidebar projection hides rows whose durable Session summary has `origin: 'subagent'`, and each visible ordinary row inherits the blue activity indicator while any descendant reached through uninterrupted subagent-origin lineage is running. The same pure derivation reads the Schedule key from list projection values for grouped, flat, and search nodes; the package uses only the type-only `@deepseek-ai/dsh-schedule/client` dependency and does not import the Schedule runtime or `ui-schedule`.

### Hover cards

Workspace and Session hover cards copy the value their row clips: activating a Workspace card writes its full directory path, while activating a non-blank Session card writes its full display title. A provisional blank New Session card remains read-only because its localized label is a placeholder rather than session content.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the sidebar host, the hero surface, and the picking backends.

- [ui-sidebar](../ui-sidebar/README.md) — the sidebar shell hosting the `sidebar.workspaces` hole.
- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the Session Intent hero's picker hole.
- [directory-picker-native](../../host/directory-picker-native/README.md) — the OS-chooser backend filling the directory-flow hole.
- [Workspace Controller](../../api/workspace-controller/README.md) — the Host mutations and framework-neutral Client projection that own Workspaces, membership, and Workspace group order.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the search depth, the archive surface, and the picking carrier; they are current package constraints.

- **No fuzzy content search or event deep links** — the content backend uses literal token/phrase matching, and selecting a result opens the Session rather than the matching event.
- **No Session deletion, and unarchive lives in Settings** — sessions can be archived but never deleted; the archived-sessions Settings page ([ui-settings-unarchive-sessions](../ui-settings-unarchive-sessions/README.md)) owns viewing and restoring them, and Workspace registration deletion does not delete Sessions.
- **Pending user interaction is not aggregated into collapsed groups** — a waiting row inside a collapsed group lights no group-header indicator and becomes visible only after that group is expanded.
- **Native folder selection depends on the local Host carrier** — under the `-native` composition, in-process or remote browser deployments cannot open a local operating-system dialog; remote-capable picking is the `-browse` composition's in-app flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This is a pure-consumer plugin that registers presentational components into two host-declared slots and registers its locale dictionaries; its inject face consists of stateless RPC wrappers plus a create-and-open call. It emits no Cordis events and owns no cross-plugin mutable state.
