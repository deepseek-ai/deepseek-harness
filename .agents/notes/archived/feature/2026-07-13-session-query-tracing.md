# Agent Note: Session query relationship tracing

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-13-session-query-tracing.zh.md)

## Problem

Session relationships are encoded across immutable headers, positional surface operations, and logged arrays of cited source-event seqs. A consumer reconstructing those relationships directly would need to duplicate corpus precedence, surface folding, malformed-log handling, deterministic lineage ordering, and cloning. Positional replacement and cited-source relationships mean different things, so collapsing them into one generic edge type would also lose meaning.

## Decision

`ctx.sessionQuery` exposes `traceSession(sessionId)` and `traceEvent({ sessionId, seq })` alongside its exact reads. Both are one-shot views over the existing live-preferred corpus: session tracing consumes one complete corpus listing, while event tracing consumes one loaded logical log and one canonical surface fold. The service retains no lineage, reverse-index, or replacement state after a call.

`SessionLineageTrace` returns the target, known parents in immediate-to-outward order, and recursive descendant trees whose siblings sort by creation time and then session id. `complete: true` carries the known root; `complete: false` carries the first unresolved parent id. A cycle connected to the target fails with `SESSION_QUERY_INVALID_LINEAGE`.

`SessionEventTrace` keeps positional replacements separate from cited source-event relationships. `replacedBy` is the immediate positional replacer, `replacementChain` follows replacers to the final node, and `replacedEventSeqs` lists the actual surface nodes directly removed by the target. `sourceEventSeqs` preserves direct logged source order, while `derivedEventSeqs` lists later direct reverse references in log order. The query does not follow cited source events transitively.

## Validation boundary

Event tracing checks target existence before surface analysis. Both event listing and tracing then use `dsh-session`'s one-pass surface fold, which accepts or rejects the loaded log as a whole: event seqs are zero-based and contiguous, surface markers obey event-type eligibility, only surface event types may cite source-event seqs, present arrays are nonempty and duplicate-free, every source is an earlier seq, and every positional replacement names and cites all surface nodes it removes. Every contract failure uses `SESSION_QUERY_INVALID_SURFACE`; there is no weaker classification-only surface standard.

All returned records and arrays are detached. A known live event trace never consults persistence; persisted event traces preserve the exact-read list/load consistency check. Session lineage is necessarily a cross-corpus operation and therefore preserves cross-corpus persistence failure semantics.

## Alternatives considered

- **Expose standalone tracing helpers** — rejected because the source-precedence and detachment boundary belongs to `ctx.sessionQuery`; public helpers would invite callers to bypass it.
- **Combine replacement and cited-source edges** — rejected because a positional replacement can shadow surface nodes while also citing non-surface construction inputs, and consumers need to distinguish those meanings.
- **Return all transitively cited source events** — rejected because it obscures logged direct evidence, increases result size, and lets one malformed distant edge alter otherwise local output.
- **Best-effort traces over malformed source-event lists** — rejected because a structurally plausible partial result would look authoritative. Exact inspection fails loudly when the canonical relationship contract is broken.

## Consequences

Consumers receive deterministic relationship views without a cache or second corpus. Event tracing performs whole-log validation and allocation on each call, while lineage tracing lists the complete logical corpus on each call. Those costs keep the source of truth explicit and are separate from the content-bearing full-text-search and filtering API.

The feature has unit and service-level coverage but no snapshot or end-to-end fixture because it introduces no model-facing consumer, transcript change, or cross-process protocol.
