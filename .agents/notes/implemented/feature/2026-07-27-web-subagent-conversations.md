# Agent Note: Web subagent catalog and human continuation

Status: implemented

English | [中文](2026-07-27-web-subagent-conversations.zh.md)

## Problem

Session-backed subagents have durable identities, persisted transcripts, and a direct-child catalog, but ordinary session lineage cannot distinguish them from forks or prove their descriptor mode and continuation authority. Generic Agent-bound Host operations can otherwise resume or drive a child outside its direct-parent continuation owner.

The browser must preserve the [continuable subagent contract](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md): a continuable child has at most one process-local Activation, accepts later work only through the exact live direct parent, and uses the Agent inbox as its sole FIFO. Viewing history must not create an Activation. Once an inbox message is accepted, the HTTP caller neither owns its execution nor gains a cancellation handle.

The UI must also preserve the membership and modes of the [durable catalog](../architecture/2026-09-01-parent-owned-subagent-catalog.md). The Web projection adds the exact child Agent driver's `running` or `inactive` state. Neither activity is a durable outcome or a promise that continuation will succeed.

## Decision

The Web product exposes the selected session's direct session-backed subagents from the current-title lineage region in the header. Users can lazily expand descendant catalogs and open either mode in the existing conversation region. A one-shot child is permanently read-only. A continuable child accepts human follow-ups only while its exact direct-parent Agent is live; otherwise its persisted transcript remains readable with a recovery explanation.

The same header row can open a child in the right Sidebar as `dsh-resource://subagentchat/session/<childSessionId>?parent=<parentSessionId>&mode=<mode>`. The open prefers a separate pane and falls back to the current pane when no split is available. The Sidebar tab renders the shared Conversation Component Factory with its width controls omitted, so main and embedded conversations share one assembly without sharing layout chrome.

Every opened child carries a catalog-derived address `{ parentSessionId, childSessionId, mode }`. The mode-bearing address, not lineage or the coarse origin marker, selects dedicated history and prompt transports. History reads the persisted session without activation. A continuable prompt carries Queue or Steer delivery through `subagent.prompt` and succeeds at inbox acceptance with `{ messageId }`; it does not expose an Activation, wait for completion, or return an outcome. Adjacent-Agent model messages use the separately owned fixed-Steer operation.

The generic Host domain preserves the same ownership boundary. `session.history` and the source side of `session.fork` read an attached Session or inspect persistence without acquiring an Agent; history folds cold projection values from that exact inspected prefix, while a fork publishes an ordinary independent session. Generic Agent-bound session, command, and goal routes return `agent-busy` for session-backed subagents, as do explicit-id `session.create` adoption and attached-only queue controls. The denial classifier accepts the coarse `origin` marker, a `subagent/descriptor` in the session's own suffix, or exact live runtime ownership by the parent; these signals only prevent generic ownership and never replace catalog mode or direct-parent authorization.

Stopping an addressed child never falls through to `session.cancel`. Browser prompt delivery owns admission only until inbox acceptance and grants no cancellation handle; a running continuable child is stopped through the dedicated `subagent.interrupt` route under the [current-turn interrupt contract](2026-08-06-continuable-subagent-interrupt.md), which parks pending work instead of discarding it. One-shot children remain uncancellable from the Web.

This decision covers Web discovery, transcript viewing, and parent-authorized human continuation. It does not make a subagent independently user-owned; that product remains [interactive side sessions](../../proposed/feature/2026-07-08-interactive-side-sessions.md).

## Design context

The Figma subagent list, hierarchical expansion, and child conversation frames are non-normative interaction and visual references. This note owns lifecycle, wire, and failure semantics.

| Design intent | Shipped contract |
| --- | --- |
| The session header opens a compact child list. | The trigger counts healthy direct entries returned by the parent catalog service. |
| Selecting a row reuses the conversation UI. | Addressed history never activates the child; only a continuable row with a live parent retains the ordinary composer. |
| Nested agents expand progressively. | A row remains expandable until its own catalog has loaded empty; expansion loads only that direct catalog and retains the row's parent address. |
| Rows show labels, state, usage, and active duration without duplicating sidebar rows. | Mode and `running`/`inactive` activity are textual as well as visual; optional title, durable token usage, and active-turn duration come from the list's retained projection values. Compact duration loses smaller units above one day, while hover and accessible naming retain exact whole seconds. `SessionHeader.origin` removes duplicate navigation rows but grants no capability. |

## Product contract

The child-count control appears when the direct catalog contains entries or its read fails; it stays hidden while an empty catalog is absent or loading, and after a successful empty read. On an ordinary session, a slash separates the current title from that control. Every subagent breadcrumb combines its compact 12px title with a fixed double chevron: the current breadcrumb uses primary color and weight 500, while ancestors use tertiary color and weight 400. Hovering a combined control for 150ms opens its direct-parent catalog, with a short crossing grace for the portaled menu; ArrowDown remains the keyboard entry path. Clicking an ancestor cancels pending hover, closes an open catalog, and only navigates upward. Each direct-parent catalog enables sibling switching and bolds its selected row; its label overrides the optional session-summary title, and a missing switcher catalog loads on interaction. Only the current subagent appends its own direct-child count control. Long titles truncate before the fixed chevron. The trigger reports the direct catalog's total and running counts. Ordinary sidebar rows hide subagent-origin Sessions and read their direct running-child count from the same loaded catalog map; Session summaries supply activity but never create membership. Running direct children use the shared tertiary-grey ongoing loader. Pending interaction outranks parent running; either remains primary while direct-child activity becomes a second hover and assistive status. An ordinary Workspace row with a pending approval, plan review, or question replaces its relative time with the compact label `Approval`, `Plan review`, or `Answer`; hover and assistive details retain the full status and relative time. With neither primary state present, direct-child activity outranks an unviewed completion reminder, which returns after the last running direct child stops. A tree row remains expandable while its child catalog is absent, loading, or failed, and becomes a known leaf only after that catalog loads empty. Loading shows a generic notice rather than summary-derived placeholder rows. The tree presents continuable and one-shot rows, falling back to the Session id when an optional one-shot label is absent.

`running` means the child Agent driver is draining work; `inactive` means that driver is idle or absent. Session-list baselines and status events supply activity, and removal marks completed subagents inactive while retaining their display projections. The shared parent `subagentCatalog` projection supplies membership. Initial reads and pushed values meet in one projection store; a newer sequence wins. [The projection-consumer decision](../simplification/2026-09-08-web-subagent-catalog-projections.md) owns loading, reconnect, and synchronization tradeoffs. A prompt response remains delivery-time authority.

Healthy rows reuse the standard session projections retained in the list mirror. The token figure sums the four disjoint `tokenUsage` buckets across the durable log. `subagentTiming` resets at every descriptor so an inherited fork seed cannot enter the child's total, accumulates completed `turn/start` → `turn/end` spans, and carries same-cut `active.since` and `active.through` bounds for an open turn. Existing session events advance `active.through` while that turn remains open; the menu adds no separate timer or log read and advances its local clock only while a known descendant is running. Below one day it formats whole seconds; longer visual values retain at most two adjacent units, using approximate 30-day months and 365-day years, while hover and accessible naming preserve the exact day/hour/minute/second duration. An inactive row bounds an interrupted open turn with `active.through`, so a stale projection never borrows newer session metadata and reopening the menu never restarts completed work. Neither metric implies a durable outcome.

Selecting a row records its exact address before opening the resident client `Session`. History pagination, event folding, tool render intents, titles, and live mux reconciliation reuse the ordinary conversation machinery. Breadcrumbs follow parent links only through `origin: 'subagent'` rows, include the first ordinary owner, and keep ordinary forks single-level. Each subagent breadcrumb gets its direct-parent sibling catalog and uses that catalog's label when available. Forking an addressed subagent creates an ordinary fork with direct source lineage and attaches it to the nearest workspace-owning ancestor. The catalog is an ARIA tree with lazy ArrowRight/ArrowLeft disclosure, linear ArrowUp/ArrowDown navigation, Home/End, Escape, and focus restoration.

A one-shot row always replaces the composer with copy explaining that the execution record is read-only. A continuable row does so only while `parentAvailable` is false and the child is not running; a running parent-offline child keeps the ordinary composer with its input and Send action disabled so independent Stop and live QueueDock controls stay reachable, and the read-only takeover returns once it stops. With a live parent, the ordinary Enter/Cmd+Enter preference selects Queue or best-effort Steer even while the child runs. QueueDock Edit, Remove, and Steer remain available for a live continuable child even when its parent is offline, while independent Stop routes through `subagent.interrupt` ([interrupt contract](2026-08-06-continuable-subagent-interrupt.md)). Prompt failures retain the draft through the ordinary error behavior.

Agent-bound auxiliary controls are unavailable in addressed child views. In particular, the model selector and `/model` contribution do not call ordinary `session.models` or `session.selectModel`; the Host also rejects any accidental call instead of activating persisted child history outside the direct-parent continuation path.

## Host adapter and wire contract

The Session Controller owns catalog and history reads; `@deepseek-ai/dsh-subagent` owns continuation controls:

- `session.projections` takes `sessionId` and returns one live-preferred Session observation’s complete projection baseline without activating an Agent. The Client seeds the standard projection store; subagent consumers select `subagentCatalog`. Parent Agent availability comes from Session-list summaries and lifecycle events.
- `session.page` and `session.follow` take the full mode-bearing address. They validate the child header, direct parent, descriptor identity, and mode at the observed cut, then return ordinary raw events, pagination, live reconciliation, and Host projection baselines without publishing an Agent.
- `subagent.prompt` accepts only a `mode: 'continuable'` address, `delivery: 'queue' | 'steer'`, and upload-shaped `PromptContentPart[]`; the Host admits and persists image parts into durable references before delivery ([image delivery](../../archived/bug-fix/2026-08-27-steer-followup-image-delivery.md)). It requires the exact live parent, revalidates the catalog address, uses the continuation manager's shared human-delivery admission, and returns the accepted `MessageId`.

The gateway maps missing parents or catalog entries, not-resumable and unauthorized children, request cancellation, image admission and image-capability refusals (`subagent/attachment-invalid`), and temporarily unavailable continuation admission to typed RPC errors. It does not expose descriptor or provider details. A list/prompt race is normal: the prompt result, not the earlier availability or activity snapshot, is authoritative.

Viewing persisted history creates no Agent by itself. When a follow-up materializes a cold child Activation, the existing Host and Session journal streams publish its lifecycle and events. Reconnect rebuilds the addressed window through `session.follow`.

The ordinary `session.page` and `session.follow` address is likewise observation-only for both ordinary and subagent sessions, but it does not carry the catalog address or grant continuation authority. Every ordinary route that needs an Agent resolves through the shared ownership fence before cold resume; `session.cancel` retains that fence. `session.updateQueue` has one target-local exception for a live child whose current projected identity is continuable and comes from its own non-seed suffix; one-shot, missing, unknown, corrupt, seed-only, or cold children remain fenced.

The adapter stays behind the generated Remote namespace; `dsh-host-webserver` remains a carrier. Browser code imports the contract through the existing connection package and never reaches host `ctx`, preserving the [archived GUI RPC layering decision](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md).

## Client object layer and presentation

The React-free runtime owns catalogs, single-flight refreshes, retained addresses, availability hints, transport selection, and a reference-stable map of each list row's current projection values. Re-selecting a known child retains its address so navigation cannot silently switch to ordinary session APIs. A missing intermediate breadcrumb address can be recovered from an already-loaded ancestor catalog, but it is not retained for transport and creates no scope until the user selects that breadcrumb. Restored navigation persists the full mode-bearing address.

Catalogs ride the standard `useSessions` snapshot. Component-local state owns menu visibility, expanded branches, focus, and hover timers. `ui-conversation` declares a lineage slot for the current ordinary title and every subagent breadcrumb, passes plain breadcrumb identity and display text plus an upward-navigation callback for ancestors, and retains the ordinary title as the render fallback. `@deepseek-ai/dsh-client-ui-subagent` occupies each lineage slot with direct-parent catalog navigation and elects a reason-specific read-only composer from ordinary owner props. Components receive derived props and callbacks, never `ctx`.

Every in-process subagent child stamps `SessionHeader.origin: 'subagent'` before publication. Session list summaries and incremental Host frames project it so grouped and flat sidebars omit duplicate child rows while preserving ordinary forks. Parent catalog projection owns membership and tree structure; descriptor identity and exact-parent checks own addressed history and continuation validation.

The package's existing `@label` source remains separate plain-text model input. It does not resolve labels to addresses or acquire continuation semantics.

## Default Web assembly

The shipped Web composition mounts SQLite session query beside JSONL persistence and configures spawn and fork background delegation as continuable. It also mounts the model-facing `send_message` and `list_agents` adapters for coordinator parity, but the GUI calls the shared `SubagentRuntime` through the host RPC domain rather than invoking model tools. One-shot children remain catalog-visible and read-only.

## Alternatives considered

**Use ordinary session APIs for addressed children.** Rejected because generic history carries no catalog-mode verification, while Agent-bound generic controls deliberately reject subagents rather than granting direct-parent continuation authority.

**Put the adapter in the webserver.** Rejected because catalog and continuation are channel-independent client capabilities; the webserver only carries validated messages.

**Put Host-backed file and session references in this package.** Rejected because catalog and addressed-child presentation depend on subagent lineage, while combined reference discovery is a separate Host capability consumed by [`ui-reference`](../../../../packages/client/ui-reference/README.md).

**Auto-resume an absent parent.** Rejected because continuation requires the exact live direct parent. Child navigation must not mutate the parent lifecycle.

**Expose ordinary cancellation.** Rejected because the accepted inbox turn outlives its admission request and, at this decision's time, the continuation contract exposed no authority-safe cancellation handle. The later [current-turn interrupt contract](2026-08-06-continuable-subagent-interrupt.md) added that explicit authority as a dedicated subagent route; falling through to `session.cancel` remains rejected.

**Show only continuable children.** Rejected because the durable catalog deliberately describes both session-backed modes. One-shot transcripts remain useful even though they never accept follow-ups.

**Infer mode or sidebar filtering from lineage.** Rejected because ordinary forks share `parentSession`. The descriptor-backed catalog owns mode; the separate `origin` marker is only a cheap navigation classifier.

**Build an eager recursive tree or dedicated catalog stream.** Rejected for the current scale. Disclosure loads missing catalogs lazily, and existing control frames carry complete projection updates.

**Let a child remain independently interactive after its parent disappears.** Rejected because independent lifetime and user ownership require side-session semantics.

## Testing

- Host protocol tests pin healthy direct catalog schemas, id echoing, mode verification, non-activating history, exact-parent enforcement, FIFO admission receipts, cancellation, and sanitized failure mapping.
- Generic Host tests pin attached and cold history and forks without Agent publication, cold projection folding, descriptor/origin/runtime-owner denial, explicit-id adoption denial, and the direct queue-control fence.
- Client object tests pin retained and restored addresses, one-shot read-only and cancel rejection, history routing, continuable prompt and interrupt routing, suppression of Agent-bound model controls, live activity from Session summaries and Agent disposal, authoritative catalog membership, and membership refresh.
- jsdom tests pin the ordinary-title separator, per-level combined subagent-title switchers, 12px nested titles, current and ancestor styling, selected-row weight, catalog-label precedence, hover delay, upward-click suppression, truncation with a retained chevron, direct counts and activity from catalogs, sidebar direct-child activity, row-status precedence, token totals, second-precision running and frozen inactive durations, adaptive long-duration units with exact accessible text, generic loading, mixed-mode rows, ready-empty leaf detection, lazy descendant disclosure, direct-parent addresses, keyboard behavior, and both read-only reasons.
- The keyless assembled Web snapshot contains an inactive continuable child with durable usage, an inactive one-shot sibling with a deterministic long duration, and a persisted grandchild; it pins direct catalog counts, usage and timing rows, adaptive long-duration presentation, and lazy nested expansion, opens persisted history without activation, admits a human FIFO follow-up, reconciles child mux events, and proves one-shot history remains read-only. A separate assembled scenario holds a real child Agent turn at the LLM seam while it pins the direct running state in both the header and visible idle owner row, then cancels the turn during teardown.
- Navigation tests pin subagent-only breadcrumbs, workspace placement for forks created from subagents, and `origin: 'subagent'` sidebar filtering without hiding ordinary forks.

## Consequences

- Catalog reads fold only the selected parent's catalog projection. Web activity comes from Session summaries, while usage and duration reuse projection baselines and pushes with no per-row log read; projection reads remain single-flight.
- Parent availability and child activity are snapshots. Publication, disposal, another sender, or another process may win after listing; typed prompt failure remains expected.
- A child may publish between history fetch and mux subscription, so the existing sequence reconciliation also covers the cold-to-live addressed path.
- Persisted origin adds one deliberately weak product-classification field to child headers and list projections; it cannot become an authorization shortcut.
- Beyond the current-turn Stop of a running continuable child ([interrupt contract](2026-08-06-continuable-subagent-interrupt.md)), the UI has no child cancellation, durable outcome, Activation identity, deletion, or independently interactive offline mode, and its text must not imply those capabilities. Active-turn duration measures logged work rather than Activation residency.
