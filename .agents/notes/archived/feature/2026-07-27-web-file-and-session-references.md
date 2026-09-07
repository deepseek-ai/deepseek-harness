# Agent Note: Web file and session references

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-27-web-file-and-session-references.zh.md)

## Problem

The Web composer had a reusable slash/reference trigger pipeline, but its `@` source was inert subagent-label text. Web needed Host-backed workspace-path discovery and structured cross-session snapshots without scanning the Host filesystem in the browser or binding session identity to a display label.

## Decision

Web exposes one combined `@file` and `@session` menu through `@deepseek-ai/dsh-client-ui-reference`. For each unquoted query it starts both Remote discovery calls concurrently and deterministically orders files before sessions with locale-registered labels; non-selectable file and session section headings distinguish the two contiguous candidate sections without entering the keyboard-selection index. The source suppresses its raw group title through loading and settled states because those section headings own the visible grouping. An open quoted token searches files only. Either candidate domain may fail independently without hiding successful rows from the other.

The file capability follows the three-package seam: `@deepseek-ai/dsh-file-reference` owns `ctx.fileReferences`, the shared `@path` token grammar, candidate shape, and stable model guidance; `@deepseek-ai/dsh-file-reference-local` owns bounded per-agent Host-filesystem indexes, invalidation, and scoped prompt installation; `dsh-client-ui-reference` consumes the generated Remote namespaces and shared grammar. A file pick is an atomic composer reference with a file glyph and filename; its serialized form remains path-only prompt text. A directory stays editable path text with a folder glyph and retriggers completion below its trailing slash.

A session pick is a structured composer reference. Its visible form uses a chat-bubble glyph and business-color session title without a capsule, while its clipboard and model form is the canonical `@[label](dsh-session:…)` mention produced by the Host. The complete `@label` display text remains in the transparent textarea, and the same-size backdrop colors that range and replaces its leading marker with the domain glyph. Native glyph metrics therefore determine width, wrapping, selection, and caret placement without truncation. The occurrence range retains reference identity for serialization; Backspace or Delete at its boundary removes it whole, and editing inside it turns the remaining characters into ordinary text. Ordinary `session.prompt` delivery carries the canonical mention unchanged. The session-reference service parses accepted direct user messages at `agent/pre-step`, captures every source, replaces the canonical mention with readable text while preserving the direct message id, and inserts the frozen snapshot immediately after that message. The recalled-context row uses the same chat glyph while other context keeps the document glyph. The API Proxy contains no reference-specific route, dependency, or error code.

The input machine keeps ordinary draft text and atomic references until the default sink reports Host acceptance. Its session-store mirror persists each occurrence's canonical clipboard projection, so remounting without the occurrence table retains a parseable reference instead of a display-only label. Serialization or prompt transport failure returns the same draft to editing. After acceptance, reference preparation belongs to the agent turn; a malformed mention, failed source read, cancellation, or budget failure terminates that turn. The logged prompt remains the replay authority. The chat renders the durable direct-message-then-recall order and associates exact session labels only from the immediately following sourced recall, which preserves multi-word titles and keeps consecutive references independent. It decorates recognized file and session mentions as icon-and-text references, treats unquoted `@path` tokens including extensionless basenames as files, leaves sentence punctuation outside the reference range, and keeps snapshot JSON behind the collapsed recall row.

## Reference transaction

```text
type @ → parallel file/session Remote calls → pick folder text or atomic file/session reference
       → serialize draft → ordinary session.prompt enqueue
       → agent/pre-step parses mentions → capture sources → readable prompt + context
```

File lookup is advisory and cancellable; selection itself performs no read. Session preparation is all-or-nothing for one accepted model step. A queued message captures each source when the message is claimed, so queue edits and queue-to-steer relocation use the same path without gateway coordination.

## Alternatives considered

**Implement file discovery and grammar inside the Web client.** Rejected because browser-side code cannot safely access the Host workspace, while duplicating grammar, ranking, bounds, and invalidation would drift from the Host provider.

**Scan files through ordinary filesystem-tool RPCs.** Rejected because recursive fuzzy discovery is editor latency work, not a model-facing exact filesystem operation, and would couple the menu to tool policy and provider round trips.

**Eagerly attach selected file contents.** Rejected because selection would spend context before relevance is known and bypass the logged, auditable `read` call/result sequence.

**Represent sessions as plain `@label` text.** Rejected because labels are neither stable nor unique and cannot identify the source snapshot. Canonical Host-produced mentions preserve opaque session identity while keeping a readable display.

**Clear the composer before prompt admission settles.** Rejected because a transport or admission failure would lose the only editable copy of the request and visually claim acceptance that never occurred.

## Verification

Package tests pin shared file grammar and ranking, cache invalidation and lifecycle cleanup, parallel Web lookup, quoted paths, independent candidate failure, cancellation, source-title suppression through pending and ready states, grouped headings that do not alter option indexes, file/directory continuation, structured file and session references, complete inline labels, domain glyphs, disabled-layer ownership, canonical draft persistence across remount, adjacent-reference and adjacent-text projection, extensionless file and sentence-punctuation rendering, codec round-trip, generated Remote type inference, direct-before-recall pre-step preparation, downstream rejection, and following-recall association for multi-word and consecutive labels. The keyless assembled Web snapshot renders the available reference sections without the raw source title, selects a file, then selects a session reference through the real client composition, and replays a multi-word session label in direct-before-recall order.

## Consequences

Web now uses the shared `@file` discovery seam and structured session-reference identity, while Host services remain the authority for filesystem and session access. File and session discovery are unary Remote contracts on the owning services, so generated client types replace handwritten RPC interfaces and browser bundles remain free of Node APIs. Candidate lookup failures remain quiet menu degradation. Reference preparation failures occur after prompt acceptance and end the agent turn. File references cost only path text plus stable conditional guidance, whereas session references retain the bounded snapshot cost and trust framing owned by `dsh-session-reference`.
