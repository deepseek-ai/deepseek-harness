# Agent Note: Prune unused stream visibility helpers

Status: proposed

English | [中文](2026-09-19-prune-stream-visibility-helpers.zh.md)

## Problem

The [compact Assistant stream implementation](../../../../packages/llm/llm/src/assistant-stream.ts) exports five visibility queries: `isVisibleChunk`, `chunkHasVisibleText`, `runFirstVisibleTime`, `assistantStreamHasVisibleContent`, and `assistantStreamHasVisibleText`. Repository searches find no production caller outside that family. Its other consumers are the [unit tests](../../../../packages/llm/llm/tests/assistant-stream.spec.ts), package documentation, and the [record-reader reference](../../../../packages/llm/llm/README.md). The package root and published `./assistant-stream` entry expose the functions to external callers, whose usage this search cannot establish.

The retained first-token reader has current consumers in [Session Stats](../../../../packages/session/session-stats/src/projection.ts) and [Trajectory](../../../../packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts). Their timing requirements do not require the separate whitespace-sensitive visibility classification.

## Proposal

Remove the five exported visibility queries and their exclusive private helpers, `hasNonWhitespace` and `blockIsVisible`. This deletes approximately 77 source lines, including local documentation, without adding replacement machinery. Retain all first-token, raw-chunk, text-joining, and assembly readers, the accumulator, and validating expansion. Preserve the direct and library-backed LLM adapters and their extension APIs.

Remove dedicated visibility tests and only the obsolete assertions inside mixed reader tests. Keep the mixed fixtures and assertions that verify first-token timing, early exit, raw chunks, text joining, and assembly equivalence.

The [package README](../../../../packages/llm/llm/README.md) owns compact-reader behavior: retained readers avoid materializing per-member expansions, and durable input still uses validating expansion. Preserve those constraints and the used readers. When implementing this proposal, update that README and the [LLM subsystem page](../../../../docs/subsystems/llm-streaming.md) with their bilingual counterparts; archived records remain unchanged.

## Alternatives considered

**Keep a complete reader family for external consumers.** This preserves convenient, tested visibility queries, but keeps public functions and dedicated tests without a demonstrated repository consumer. A named external requirement would justify retaining or reintroducing them.

**Replace visibility queries with stream expansion.** There is no production caller to migrate. Adding replacements would retain an unused API and introduce the allocations the record readers avoid.

## Acceptance criteria

- The five names disappear from source exports and current API documentation; no production caller gains an expansion or replacement visibility query.
- Focused stream-reader, Session Stats, and Trajectory timing checks pass; mixed tests retain their unrelated assertions.
- Typecheck, affected published-entry builds, and documentation checks pass. Session formats, model input, transcript content, and first-token timing remain unchanged.

## Risks

This deliberately contracts exported pre-stable APIs. An external import may break even though repository consumers are absent. Refresh consumer evidence before implementation and assess any identified external requirement explicitly; do not claim ecosystem-wide non-use.
