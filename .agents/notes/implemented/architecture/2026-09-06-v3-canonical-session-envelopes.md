# Agent Note: Canonical V3 Session event envelopes

Status: implemented

English | [中文](2026-09-06-v3-canonical-session-envelopes.zh.md)

## Problem

A Session event can cross in-memory, durable, and browser-wire readers. If its type permits missing placement or unrelated surface metadata, a reader can silently omit a message or disagree about which fields affect reconstruction. Multiple spellings for replacement endpoints and empty request-header optionals also allow different stored records to describe the same request. Contradictory tool failure metadata can make model history and diagnostics report different outcomes.

## Decision

Session format V3 uses one canonical event envelope. Every `system/message`, `user/message`, `assistant/message`, and `tool/result` requires `surfaceOp`. Known log-only events permit only `type`, `seq`, `time`, `data`, and optional `ignorable: true`; their TypeScript variants declare both surface metadata fields as optional `never`. Native unknown or obsolete ignorable envelopes remain opaque, including their metadata. Assistant messages embed their exact provider stream and alone forbid `sourceEventSeqs`. System, user, and tool messages may cite a non-empty, unique set of earlier source sequences.

`SurfaceOp` is exactly `'append'` or `{ op: 'replace', startSeq, endSeq }`, with `SessionSeq` endpoints and no aliases or extra keys. Both endpoints precede the replacing event and identify an inclusive span in current surface order, not numeric sequence order. Session acceptance additionally verifies current membership, ordered endpoints, complete cited coverage, and content-only single-node tool-result replacement. Compaction payload fields such as `shadowedRange.start/end` and fold-result fields retain their own names; this is not a recursive payload rename.

Current acceptance rejects every `request/header.header.system` and exactly empty `tools: []` or `adapterDefaults: {}`. System prompts belong to `system/message`; `request/header` remains the non-history request snapshot. Writers omit the two empty optionals. Whitespace-only system content, `config.stop: []`, nested header/source/data extras, and nested tool schema values remain intact. A `tool/result` with `data.error` requires `message.content[0].isError === true`; a failed result need not carry error identity. Neither current reads nor migration infer an error outcome from contradictory metadata.

### Validation ownership

[Core Session](../../../../packages/core/session/src/surface.ts) owns event-local placement, header-empty-field, and tool-error rules, while its surface manager owns relationships that need the event log. Seed, append, and restoration apply these rules before accepting events. They do not create a general schema for plugin-owned payloads or eagerly expand embedded provider streams.

The generic Gateway client returns raw outputs without validating them. The existing [SessionEventStream](../../../../packages/api/session-controller/src/client/transport.ts) therefore checks follow snapshots, live durable entries, and history pages before publishing them. Its private [wire-event checker](../../../../packages/api/session-controller/src/client/session-wire-event.ts) validates the exact envelope and delegates event-local rules to the browser-safe core validators. It does not add a generic Gateway schema or validate unrelated plugin payloads. Surface membership and source existence remain Host-owned because a browser window may omit earlier events.

### Released V2 to V3 conversion

The [V2-to-V3 specification](../../../../packages/session/session-format-v2-to-v3/README.md#v2-to-v3-specification) owns the complete historical conversion, its [canonicalization rules](../../../../packages/session/session-format-v2-to-v3/README.md#canonical-envelopes), and [native admission and recovery](../../../../packages/session/session-format-v2-to-v3/README.md#native-v3-admission). Keeping these rules together prevents a cardinality-preserving canonicalization step from being mistaken for an identity migration. Frozen relationship validation uses private views rather than runtime aliases; the original V3 artifact remains authoritative.

## Alternatives considered

**Default missing placement to append.** This invents a model-history decision absent from the stored record and admits invalid V2 artifacts. Required placement keeps all readers accountable to the same evidence.

**Accept both replacement spellings in current readers.** This preserves two durable representations and makes validation depend on which reader receives them. Only the adjacent edge interprets released keys; current readers accept V3 keys exclusively.

**Normalize all empty values or repair tool outcomes.** Empty stop lists, whitespace, and plugin payloads can be meaningful. Removing them or setting `isError` from diagnostics changes recorded facts. The edge performs only named, semantics-preserving conversions and refuses contradictions.

**Copy historical validators or pass V3 events directly to them.** Copying duplicates relationship semantics; direct reuse would accept obsolete envelope spellings and misinterpret system nodes and repair identities. Strict V3 validation followed by composed private views reuses frozen relationships without widening current acceptance.

## Consequences

Typed events, persistence, and browser history agree on required placement and event-local failure semantics. Malformed records fail before projection rather than disappearing from model history. Migration gives up best-effort recovery of contradictory records; retained source generations remain untouched under the [released-format publication policy](2026-08-31-released-session-format-migrations.md).

This decision partially supersedes envelope representation details in the [session surface](2026-06-18-session-surface.md) and [reconstructable requests](2026-07-05-reconstructable-requests.md) notes. They remain active for ordered projection and logged request ownership. The [system-prompt surface-node decision](2026-09-02-system-prompt-as-surface-node.md) retains prompt ownership, protected-head semantics, and migration rationale. The [V2 embedded-stream decision](2026-09-01-v2-embedded-assistant-streams.md) remains active for attempt settlement, exact stream evidence, and cardinality-changing migration; V3 preserves those decisions.

## Verification

[Core acceptance tests](../../../../packages/core/session/tests/canonical-envelopes.spec.ts) pin invalid seed/append/restore records, typed surface variants, optional failure identity, and unchanged derived state after rejection. [Browser transport tests](../../../../packages/api/session-controller/tests/transport.client.spec.ts) exercise strict follow/page admission before publication. [Migration tests](../../../../packages/session/session-format-v2-to-v3/tests/canonical-envelopes.spec.ts) cover conversion and restoration; frozen adjacent-edge suites preserve historical semantics. Required coverage also includes codec admission, whitespace and empty stop-list preservation, opaque payload retention, and numerically descending replacement endpoints in valid surface order.
