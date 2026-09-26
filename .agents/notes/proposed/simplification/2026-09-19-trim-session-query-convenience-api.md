# Agent Note: Trim unused SessionQuery convenience methods

Status: proposed

English | [中文](2026-09-19-trim-session-query-convenience-api.zh.md)

## Problem

[`SessionQueryEngine`](../../../../packages/session-query/session-query/src/index.ts) maintains `readSession`, `readTitle`, `readTitleSnapshot`, and `listEvents` without executing first-party product callers. Exact-name and call-site searches find internal delegation, tests, and generated discovery metadata. Current consumers use retained observations, batch titles, surface reads, and traces. The generated catalog exposes these methods to plugin authors but does not execute the advertised operations.

These entry points add replay-validation and result-copying paths, wrappers, public types, and endpoint-specific tests. Their removal can reduce maintained API obligations without replacing the shared query implementation.

## Proposal

Remove the four methods, the unreferenced [`SessionLogSnapshot`](../../../../packages/session-query/session-query/src/types.ts) result type, and [`eventRecords`](../../../../packages/session-query/session-query/src/tracing.ts). Remove their imports and current documentation, including the `SessionLogSnapshot` type-equivalence block and explanatory paragraph in both subsystem pages. Remove its hand-maintained entry in the [type-equivalence manifest](../../../../scripts/type-equiv.manifest.json) and its `LINK_MAP` entry in the [catalog generator](../../../../scripts/gen-cordis-catalog.ts), then regenerate discovery metadata. The selected definitions occupy approximately eighty source lines before import and metadata cleanup; no replacement service is needed.

Retain `filterEvents` and `_filterEvents`, together with their semantic extraction and filtering helpers. Retain `observeSession`, `readTitleSnapshots`, `readSurface`, `readEvent`, listing, search, and tracing. Preserve shared corpus resolution and its existing ownership and failure behavior.

The [historical unified-query decision](../../archived/architecture/2026-07-23-unified-session-query-service.md) explains the retained single-service topology. This proposal removes selected convenience operations, not that topology. No active note is fully superseded; keep archived records frozen and link this narrower decision from affected current documentation.

## Alternatives considered

**Retain all documented methods for external callers.** This avoids migration for installed plugins, but keeps four APIs without a current product caller. The pre-stable API policy permits a deliberate removal with explicit migration costs.

**Remove `filterEvents` too.** Rejected because its provider-independent literal substring scan differs from FTS token matching. The [SQLite query documentation](../../../../packages/session-query/session-query-sqlite/README.md) explicitly recommends this operation; removing it would withdraw a distinct query capability.

## Acceptance criteria

- Remove the four methods and orphan definitions from source, package READMEs, subsystem declarations, and generated catalogs; retain literal substring queries.
- Preserve live-source precedence, corruption refusal, cancellation, detached results, cold reads, and batch-title behavior through retained endpoints. Move relevant assertions from removed-method tests instead of deleting their shared guarantees; account for `readSession`'s additional replay validation.
- Run focused query, SQLite-query, tool-query, and affected context-reference tests, relevant keyless query recordings, catalog generation, typecheck, lint, and doc-sync. Released Session generations remain unchanged.

## Risks

Repository searches cannot enumerate installed or dynamically authored plugins. Such callers lose complete-log and lightweight-record convenience operations and must adopt retained APIs with their actual ownership and error semantics. A demonstrated consumer requiring a removed operation would justify reconsidering that operation separately.
