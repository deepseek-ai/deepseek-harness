---
description: "Subagent conversation catalog in the Session panel, breadcrumb sibling switcher, continuation routing UI, and '@' reference source for the dsh web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent

English | [中文](README.zh.md)

## Summary

Browse local subagent conversations and external tasks in the Session panel's Subagents section, and switch between siblings from a child conversation's breadcrumb. Local conversations show activity, token usage, and duration; continuable children accept follow-up prompts and support Stop. External tasks appear as non-navigable leaves without an execution status. Historical one-shot conversations open as read-only records. The ordinary sidebar omits subagent conversations, and the separate `@` source inserts a running child's label without granting continuation authority.

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

The session header uses the session title for ordinary breadcrumbs. Subagent breadcrumbs prefer the original creation description (`entry.label`), then the agent name (`entry.name`), then the Session id. Ordinary and subagent breadcrumb titles both use 14px text with a 20px line height. Each subagent breadcrumb title is a switcher over its parent's direct catalog that marks the title's Session as current; root Sessions have no switcher. The [Session panel](../ui-session-panel/README.md#contribute-a-section) section `subagents` (order 200, titled “Subagents”) lists the current Session's direct catalog, in root and child conversations alike, when the catalog has entries or a read has failed. Showing the section reads nothing; expanding a branch prepares that branch. An absent or empty catalog hides the section and its title unless a footer contribution is available and the Session's enabled `agentTeam` projection has nondeleted shared tasks or a task-record error. Enabling Team mode alone does not show an empty section. Select a local child at any depth to open that child's conversation with its exact `{parentSessionId, childSessionId, mode}` address, or use a noncurrent local row's trailing arrow to open the same address in the right Sidebar, preferring a separate pane when room permits. Either action closes the panel's overlay or the switcher menu that holds the row.

This package registers the `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>` resource and builtin Sidebar tab type. The resource retains the child `SessionReference` directly from its address without refreshing the parent catalog, and releases the reference when the tab record closes. The tab renders the shared `conversation.content` Factory through `sidebar.chat.conversation`, fixes the local View to Chat, and omits the main Conversation header and width controls. A Workspace picked in a blank child's Hero opens that Workspace's blank Session as the main Session and moves the draft to it, as the main Conversation does.

Dragging a root Session row from the Session list shows a drop target while another Session is on screen. While the right Sidebar is open, one target covers each docked pane, leaving the panes' divider and the chat area visible, and a drop opens the Session in that pane. While it is collapsed, one target covers the area the Sidebar would open in, never left of the navigation column or narrow-window drawer that the row left, or that whole area right of the column when the Sidebar cannot fit. Each target draws only its card, 8px in from every side, so the Sidebar's left border and the divider between panes stay visible; with several panes, only the target under the pointer shows its card. Targets stack above the drawer's mask. Dropping there opens the dragged Session as `dsh-resource://subagentchat/session/<id>`, an address without a query, in the on-screen Session's Sidebar, or reveals the tab that already shows it. Its Conversation accepts follow-up prompts like the main Conversation, and the tab is saved with that Session's browser-local Sidebar layout. The tab title is the Session's display title.

The section's title control (`conversation.session.panel.section.actions`, key `subagents`) shows direct-member progress: completed, in progress, not running, and external counts in that order, with zero counts omitted and the separator matching the input task list. External tasks never count as running or completed. The section lists running subagents first, the most recently started first, and then the others, the most recently updated first. It shows five rows and then the Session panel's fold control, “Show {count} more”, which shows the rest and then reads “Show less”; the list folds only when that holds back two rows or more, the choice holds for the Session, also after the panel is hidden and shown again, and an expanded branch's own rows all show. The section hides with its title while the Session has no subagents and no failed catalog read. While direct subagents run and the panel does not show, a blue dot on the panel toggle (`conversation.session.panel.indicator`) says so and names their number for assistive technology; external tasks do not count. The Session panel scrolls the section; the tree has no nested scrolling. The breadcrumb switcher menu is 360px wide with 6px outer padding, constrained to fit the layout viewport, and only the menu scrolls. In WebKit-compatible browsers, its native 5px scrollbar sits in the right 6px inset with inset track ends and a stable gutter, preserving content width when scrolling becomes necessary. Other browsers retain their standard native scrollbar.

Breadcrumb switcher menus show navigation only.

The switcher title is at most 244px wide, ellipsizes, and is followed by an up-down chevron icon. The current Session's title uses primary ink at weight 500; an ancestor's title uses tertiary ink at regular weight.

### Browsing the tree

The sidebar-action tooltip appears after 500ms of hover. Hovering a switcher with a non-touch pointer opens its menu after 150ms; leaving both the switcher and its menu closes it after 120ms. Clicking the current Session's title opens and pins the menu and moves focus into it, and a pinned menu ignores pointer leave; clicking an ancestor's title navigates to that ancestor instead. ArrowDown on a switcher opens its menu and focuses the first row; on an open menu it moves focus into the menu, to the first row once the rows have loaded. An outside press or Escape closes the menu, and Escape returns focus to the switcher when focus was inside the menu.

Rows show the creation description, or an available Session title, with the agent name, which is unique among its siblings: in switcher menus the name sits below the title, and in the Session panel each row is one 28px line whose hover card, after 500ms of hover, shows the title, the name as its owner, the activity with the mode, and the token total and exact duration. Entries recorded without a name show the Session id in its place. Without either description, the row shows only the name or Session id. Navigation, row identity, and Sidebar addresses always use the Session id. Local rows use compact 4px vertical padding. In the Session panel they follow the panel's columns: the status glyph's center 14px from the row start, titles at 30px, and the sidebar arrow's center 14px from the row end. In switcher menus, their clickable content uses 6px horizontal padding and 7px gaps while retaining the tree's left offset. A decorative trailing check marks the current conversation and is not an action; other local rows retain the sidebar arrow, a 24px target whose glyph darkens on hover without a fill in the panel and in switcher menus alike. Primary titles use 13px text and secondary names use 12px. Switcher rows wrap descriptions and names in full, including on touch screens; panel titles clip with an ellipsis, and the row's accessible name keeps the name, mode, activity, and measures. Running uses the shared ongoing loader, an inactive child whose latest closed turn completed normally uses the shared success dot, and other inactive children use the shared idle dot. Every row reserves the same status column, 16px in the panel and 14px in switcher menus, centering smaller dots so titles align with the loader state. In switcher menus the trailing column stacks total durable provider usage above active-turn duration; panel rows show only the compact duration, in 12px text. In the tree, Enter or Space opens the focused row, ArrowRight/ArrowLeft expand and collapse branches, and ArrowUp/ArrowDown, Home, and End move between rows. An unlabeled one-shot row falls back to its session id. Only rows with confirmed children show an expansion arrow. Preparing a level reads its catalog and its direct children sequentially through the existing projection reader, which reuses completed reads and merges in-flight requests; it does not recursively discover deeper descendants. Once started, a level read may finish after the panel hides or the menu closes. Missing catalogs show no expansion arrow or unknown marker; shared projection updates reveal confirmed branches while preserving the agent activity marker. Failed reads keep navigation available and offer Retry.

### Continuing a conversation

A continuable child keeps the ordinary input and independent Stop action regardless of creator availability. Prompts route through `subagents/prompt`, whose runtime validates the creation address and live Team root; failures use ordinary prompt feedback. Stop routes through `subagents/interruptByUser`.

### The `@` reference source

The `@` source remains deliberately separate and inert: candidates are zero-RPC running children from `ctx.sessions.list`, picking one inserts literal `@label ` text, and the codec projects `@label`. It has no command-adjudication hooks and does not resolve labels into continuation addresses.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [subagent runtime](../../subagent/subagent/README.md) owns continuation and interruption; the [conversation reference](../ui-conversation/README.md) documents composer behavior.

### Catalog derivation

The Subagents section, its progress control, and the breadcrumb switcher read `subagentCatalog` only from `projectionsBySession` through the standard `useSessions` hook. The Session object layer merges list-cache hints, explicit reads, and the Host-wide control stream into these shared values; live frames update loaded levels without per-tree subscriptions. Activity prefers the unified UI status and falls back to Session summaries; summaries also supply titles and usage. Showing the section, rendering, and hovering use only local projections and never request missing catalogs. An unread empty switcher menu says “Subagents not loaded”; the loading notice appears only during a request. Missing and explicitly empty catalogs have no expansion arrow; a later shared projection with children makes the arrow available. Failures require explicit retry. Migration-required rows keep their history-opening actions without a format notice or descendant expansion; opening the Session supplies its catalog through history and control projections. External rows are always leaves and do not load child Sessions.

The Session panel owns showing, scrolling, and dismissing the section. The switcher menu is a body-mounted `MenuSurface`; CSS anchors keep it attached to its title within layout-viewport size limits. Browser zoom and panning move it with the page, so it may extend beyond the visual viewport. Internal scrolling, hover behavior, pinned opening, and focus restoration remain independent.

A pinning click or ArrowDown on a switcher title, branch expansion, and failed-read retries call `prepareCatalog` to read the current catalog and its direct children; a rejected preparation is logged to the console. Ancestor-title clicks navigate to that Session. The Session object layer deduplicates reads and refreshes previously requested projections after reconnect.

Breadcrumb addresses derive from the Provider-bound Session address, loaded parent catalogs, or already-listed subagent lineage, including never-selected ancestors.

### Duration, completion, and tokens

Each visible catalog level advances its own clock while it contains a running child; collapsing the level, hiding the panel, or closing the switcher menu releases that clock. Token totals sum the four disjoint `tokenUsage` buckets. The `subagentTiming` projection sums completed-turn duration and supplies `lastTurnCompleted` for both the success dot and completed count; opening another turn clears that completion until its own `turn/end`. Duration advances once per second only for an open turn on a running child and freezes after the child becomes inactive; an interrupted open turn is bounded by its same-cut `active.through`, never by newer session metadata.

### Composer election

One-shot and unknown-mode children elect a read-only composer. Continuable children route prompts through `subagents/prompt`. This package never receives host context or calls a model-facing tool.

Unknown-mode catalog rows remain visible and clickable, using the child id when no label is available. Their composer is read-only until child history establishes a supported mode; a read failure is reported in the child conversation.

Catalog row highlights use the standard menu item radius from the [nested geometry rules](../../../docs/ui-radius.md#nested-hover). Each branch disclosure target covers its 28px left gutter and full row height without overlapping adjacent rows; only the 12px glyph rotates in place, and disclosure clicks do not trigger row or sidebar navigation. Disclosure hover highlights only its arrow; navigation-body hover and keyboard focus retain their background highlight. Thin level-3 border connectors align with the first-line glyph centers, cross reserved disclosure space to reach leaf status glyphs, and end the final vertical stem at its glyph center.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the conversation surface, the host seam, and the design notes.

- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the breadcrumb lineage and composer chain.
- [ui-session-panel](../ui-session-panel/README.md) — the Session panel hosting the Subagents section.
- [ui-input-trigger](../ui-input-trigger/README.md) — the suggestion machinery hosting the `@` source.
- [subagent](../../subagent/subagent/README.md) — the host-side capability seam behind continuable children.
- [historical Web subagent conversations](../../../.agents/notes/archived/feature/2026-07-27-web-subagent-conversations.md) — the catalog and composer specification.
- [Current-turn interrupt](../../subagent/subagent/README.md) — the independent Stop semantics.

-----

<a id="model-experience"></a>
## Model Experience

### Subagent label text in the user prompt

#### What the model sees

Only the `@` reference source affects model input: a picked candidate reaches the ordinary user message as literal `@label`, without a dedicated block or host-side resolution. Catalog browsing, child navigation, and persisted transcript viewing add no prompt section; accepted continuation content becomes a normal FIFO user message through the host subagent adapter.

#### Token effect

Conditional and append-only: the literal `@label` or a human follow-up adds tokens only to its new user message. Catalog and transcript operations add zero model tokens.

#### KV Cache effect

Append-only. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the catalog can show and what `@` references mean; they are current package constraints.

- **Non-completed inactive outcomes remain grouped** — the catalog distinguishes a latest normal completion from other inactive states, but does not distinguish failure, cancellation, refusal, token exhaustion, or a child with no closed turn; the UI exposes no Activation identity, and stopping is limited to the composer's current-turn Stop for a running continuable child.
- **Ancestor menus require keyboard activation for uncached branches** — hovering does not read, and clicking the ancestor title navigates. Focus the title and press ArrowDown to prepare that level without leaving the current Session.
- **Level discovery stops on interruption** — an unexpected read rejection stops later siblings and is logged to the console. A reconnect can interrupt discovery before direct children are read; explicitly reopen the menu to prepare the level again.
- **The Session panel section has no level activation** — showing the section reads nothing, so a direct subagent whose catalog the Session list has not cached offers no expansion arrow there until its catalog arrives, for example after its own conversation opens or a sibling's breadcrumb switcher prepares the level.
- **`@` references remain display-title text** — duplicate or renamed labels are ambiguous, so they intentionally do not acquire continuation semantics.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
