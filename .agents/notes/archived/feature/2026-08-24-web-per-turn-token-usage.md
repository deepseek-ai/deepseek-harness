# Agent Note: Exact Web per-Turn token usage

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-24-web-per-turn-token-usage.zh.md)

## Problem

Web Chat exposes cumulative session token usage near the composer, but that value cannot explain the cost of one completed Turn. A paged history window may begin inside a Turn, retries may consume several model calls, streaming and final events may repeat one attempt's usage, and optional cache fields do not prove an exact total. Displaying a partial subtotal as Turn usage would make recorded provider facts look more complete than they are.

## Decision

The shared `TokenUsage` value carries optional `totalTokens` for one model call. Adapters publish it only from an exact provider total or authoritative aggregate prompt and output counters. DeepSeek checks its prompt-plus-completion aggregate against any wire total, and pi-ai preserves its provided total.

Token-meter owns a browser-safe pure Turn-local fold over durable session events, shared with its retry-aware cumulative usage projection. `step/start` and `llm/retry-started` open actual attempts; a final assistant message replaces the same attempt's streaming sample; terminal failures, retries, and step boundaries close attempts without double counting. Every started attempt must close with safe non-negative integer usage and an exact total. Optional cache, reasoning, and route aggregates appear only when every contributing attempt reports them, and reasoning remains a subset of output.

Web Chat selects a Turn only when its loaded match window includes `turn/start`, passes that complete durable-event window to the token-meter fold, and renders the result. A complete, exact result appears through a local-state `DisclosureRow` above the existing actions; incomplete or contradictory evidence produces no row. Chat owns no token-accounting state machine.

## Alternatives considered

**Subtract neighboring cumulative session values.** Rejected because pagination, compaction, retry coverage, and projection completeness can make adjacent values incomparable; subtraction would infer data that no call reported.

**Publish historical per-Turn values through a new client session projection.** Rejected because the loaded per-Turn view already has the durable attempt events it needs, while a history-growing projection would add transport, persistence, and versioning costs. Reusing token-meter's pure fold keeps one accounting owner without adding another wire value.

**Show known buckets without an exact total.** Rejected because a lower-bound subtotal presented in a completed Turn footer is indistinguishable from a complete bill.

## Consequences

New provider records can expose exact per-Turn accounting without a new transport or persisted UI state. Older sessions and adapters without enough evidence simply omit the disclosure. Model routes disappear as a group when any billed attempt lacks attribution, while trustworthy token totals remain visible.

Focused adapter, token-meter fold/projection, component, pagination, and assembled Web replay tests pin total preservation, retry-attempt separation, fail-closed validation, optional-field omission, interaction, and full-window publication. The cumulative projection and exact Turn fold now share token-meter ownership; the projection remains a whole-log bucket view, while the fold alone makes the stricter exactness and completeness claim required by the disclosure.
