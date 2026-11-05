# Agent Note: Durable rich-text quotes in the Web composer

Status: implemented

English | [中文](2026-08-26-web-rich-text-quotes.zh.md)

## Problem

Selected transcript excerpts need atomic editing and reload-safe drafts without depending on the availability of their source messages.

## Decision

`ui-conversation` owns an inline `QuoteNode` beside reference nodes in the existing editor runtime. Its clipboard projection is canonical Markdown, while its detect projection is one atomic character. The existing semantic `DraftSnapshot` persists quote text and clipboard-coordinate spans beside references; raw Lexical JSON and runtime node identities remain outside browser storage. Session switching, Workspace transfer, and failed-send restoration use this same snapshot. Quote controls receive runtime-only locale labels.

`ui-chat` accepts one nonblank browser selection within displayed user content, including pending steering and local submission echoes or finalized Assistant text and reasoning. Streaming and interrupted Assistant output, tools, injected context, and Markdown controls are excluded. Selection extraction follows visible line and block breaks and inserts through the current Session input actions.

Text interaction belongs to the shared primitive and the Chat-owned list Slot. Quote registers only gesture admission and insertion. Local absolute placement keeps actions in the content coordinate system; outside presses and Escape close the same area-owned interaction for every consumer. Dismissal and selection clearing are separate operations so a failed insertion preserves the excerpt. Context-menu consumers cancel their originating browser event synchronously; rendering a Slot cannot retroactively cancel it.

The [text-derived blockquote decision](../simplification/2026-10-13-text-derived-message-quotes.md) owns sent-message recognition and presentation. The [UserText evaluator](../architecture/2026-10-10-user-text-json-nodes.md) renders derived quote nodes through the existing matcher registry.

Quotes display a compact single-line preview; clipped excerpts expose the complete text in a shared inline HoverCard. Their text has no source-navigation action. The editable draft alone exposes whole-node removal. Only selected text survives message persistence: no source Session, message, or selection coordinates are retained.

## Alternatives considered

**Persist Lexical JSON or introduce another draft format.** Editor serialization would become a product storage obligation, while a second draft format would duplicate restoration and transfer ownership. The existing semantic snapshot already carries reference spans and extends to quotes.

**Retain source navigation.** Availability checks would require source coordinates, subscriptions, history pagination, focus routing, and failure states. A future navigation feature must define those durable coordinates and target-owned actions before adding them.

**Store UserText nodes or callbacks.** Text nodes are derived presentation, and callbacks are runtime state. Both can change independently of the logged input and semantic draft.

## Verification

Composer tests cover atomic removal and undo, semantic storage round trips, Markdown serialization, and failed-send restoration. UserText tests cover text recognition, literal excerpt rendering, literal references, and credential spelling. The keyless Web scenario exercises selection, clipped previews, draft switching and reload, persistence, and ordinary Markdown submission through the shipped composition.

## Consequences

The draft and Session retain enough data for atomic editing and replay without retaining source-history dependencies. UserText remains a display projection; its JSON nodes never replace authoritative content. Browser-local storage retains unsent selected text under the existing draft policy.
