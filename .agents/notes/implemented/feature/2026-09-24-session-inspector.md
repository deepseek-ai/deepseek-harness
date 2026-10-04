# Agent Note: Session Inspector data ownership and navigation

Status: implemented

English | [中文](2026-09-24-session-inspector.zh.md)

## Problem

Debugging a Session requires its raw log, Chat structures, and rendered conversation side by side. Runtime objects share Node, Turn, and Step identities and contain cycles, so JSON alone cannot support reference navigation. The Inspector needs an independent entry without making every Conversation View a Sidebar resource.

## Decision

`experimental/session-inspector` registers the `session-inspector-log` Sidebar page and its Session-scoped body. The existing Sidebar owns the Session reference. The Inspector adds no resource provider, Conversation header slot, composer, or product-package navigation API. The [Session Inspector README](../../../../packages/experimental/session-inspector/README.md) owns the table controls and presentation behavior.

- Session Controller and Chat retain ownership of the data. Only the selected table subscribes; the log uses the existing loaded window and pagination, without another Session stream or persistence format.
- The virtual table groups Turn → Step → event → Assistant block/delta. Open blocks expand and closed blocks fold. Automatic folding preserves the visible row or retained ancestor through trailing space; manual folding anchors the clicked header and pauses following. Sticky ancestors are chosen below the table header and earlier sticky rows.
- Chat keeps its actual root order and group membership. Materialized nodes outside visible groups are inserted by event anchor, not appended after the final Turn. Content changes retain row identities.
- WeakMap references identify Node, Group, their Data roots, and Turn/Step locations and Data readers. Breadcrumbs retain readers rather than copies. Node Data can expand inline; named references and ancestor detection stop recursive expansion.
- Object fields are read lazily in pages of 50 entries. Conversation publications invalidate expanded-field caches because Location Data readers can mutate without changing identity. UI-only renders reuse cached fields. Getters never run automatically, and weak collections remain opaque.
- Navigation stays in the experimental package. It uses existing Slot/Chat data attributes and the current UI Session to find the main Chat, excluding Sidebar, hidden views, and nested conversations. Searchable folded ancestors receive `beforematch`; the Inspector does not write Chat's fold state.
- Visible targets only flash. Offscreen targets use native smooth scrolling before a body-level clipped overlay flashes. User interruption, replacement, mode changes, or disposal cancel pending work. Log rows may map approximately to a nearby loaded Node, Group, or Turn; navigation never switches the main View or loads history.
- Picking uses a real click-catching mask over Chat. `elementsFromPoint()` and the isolated matching functions resolve the underlying record; the mask prevents its click action and forwards wheel movement to existing scrollports. Cancellation removes the mask, overlays, and listeners.

## Runtime diagnostics

The default-off `inspector-profile` optional bundle enables Session inspection and the NodeJS debugging Worker with unredacted Host fetch capture. Enabling the bundle requires no debugging argument or user override. The implementation and explicit source/built overlays remain available; Web startup accepts no new argument and Settings gains no debugging button.

The Host owns the debugging URL, Worker, and capture lifetime. When the composition supplies `--inspect`, the Host attempts to open Chrome; failure leaves the printed link usable. Closing the debugging window does not stop capture. Explicit activation permits local code execution and unredacted network capture, as disclosed in the [Inspector security section](../../../../packages/experimental/inspector/README.md#security).

A Client loaded after the page obtains current ingest parameters through an authenticated document-relative Connection route. Initial injection still supports early connections. Connection resets refresh parameters; replacement releases the previous source, and disposal aborts and waits for outstanding work. The Client never receives or launches the debugging URL.

## Alternatives considered

**Generic Conversation View resources and header labels.** They require address validation, separate Session references, unavailable-view recovery, and composer options for a single consumer. An existing Sidebar page type is sufficient; a generic protocol needs independent consumers before reconsideration.

**Sidebar registration in `ui-conversation`, including split header exports.** Sidebar already consumes Conversation headers. Reversing that dependency creates a TypeScript project-reference cycle that optional runtime injection and type-only imports cannot remove. The experimental consumer depends on both packages through their normal `/client` entries.

**Reuse `subagentchat`.** It owns a complete subagent conversation and composer, not raw inspection. A dedicated page leaves ordinary and subagent Chat behavior unchanged.

**Target-owned navigation through generic events.** This isolates DOM implementation but adds request types, routing, acknowledgements, and lifecycle code to product packages for an experimental consumer. Inspector-owned DOM adaptation accepts maintenance when existing attributes or layout change.

**Serialize all Chat objects as JSON.** Shared identities, cycles, and Map keys would lose interactive structure. Weak references and a lazy object tree preserve navigation without retaining replaced snapshots.

**Shrink the list immediately after a stream closes.** A long block's collapse changes the viewport. Trailing space preserves the anchor and is consumed by new rows; Follow Latest clears it.

**Read initial page injection only.** Late plugin activation has no initial injection. Fetching the current bootstrap decouples connection from page-load timing.

**Let the Client open the debugging URL.** The browser page does not own Host application startup. Host-side launch keeps URL handling and process lifetime together without another launch service.

## Consequences

The Inspector owns local filters, disclosures, selection, breadcrumbs, and highlights, not Chat business state. It can only inspect loaded history and mounted main-Chat content. Projection control-stream updates are not displayed. The Session Inspector plugin alone starts no debugging endpoint or request capture; enabling the optional bundle also enables NodeJS Inspector and fetch capture.

The earlier [optional-bundle decision](../architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md) continues to own installation and provider-runtime trade-offs. This feature adds the Inspector profile to that list rather than making all experimental providers optional bundles.

## Testing

Package tests exercise registration disposal, hierarchy and folding anchors, hidden-node ordering, filters, object navigation and cache invalidation, DOM scope, smooth scrolling, picking, and cancellation. Work-count regressions bound indexed first-page reads and prevent historical regrouping during append. Diagnostic tests cover Loader activation, injected and fetched bootstrap failures, reconnect recovery, registration rollback, failed window launch, and joined disposal. The Web scenario in `snapshots/web/session-inspector` replays a recorded Session through the optional bundle and checks log filtering, object details, and Chat Group order.
