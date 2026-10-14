# Agent Note: Present single-Session migration through follow redirection

Status: proposed

English | [中文](2026-09-29-session-migration-follow-redirect.zh.md)

## Problem

Opening historical Sessions can wait for lengthy format conversion. Ordinary loading cannot explain the current phase or show migration failure; placing progress inside history events would contaminate the model log and change journal sequence semantics.

## Proposal

Add a typed business redirect to single-Session history reads: page or follow returns a migration reference when preparation is required, the Client follows that migration for its current phase and subsequent progress, then returns to the original history read after success. “302” denotes a business result, not a browser HTTP redirect, and accepts no arbitrary URL.

The Session object layer owns redirection, waiting, failure, and reopening. React must observe an explicit migration state and render a dedicated component; failure retains its cause and retry action. Migration success returns only to history loading, and a valid snapshot establishes history readiness. Paging and reconnect retain existing history and drafts.

The actual persistence preparation owner retains migration ownership; multiple waiters share work and late joiners receive current state immediately. Closing one view releases only its waiter. Started durable publication retains its run-to-settlement policy. Progress enters neither the Session log nor `session.control` for this flow.

Create/adopt and full-text search keep automatic processing; fork and catalog reads use the [migration prerequisite](../../implemented/architecture/2026-09-29-explicit-session-history-preparation.md).

### Completion milestone remains open

Read-open currently produces validated in-memory history; write-open encodes, verifies, and publishes a new generation. If redirection waits only for read preparation, its reference must retain the prepared result until the original follow takes ownership rather than relying on an evictable short-lived cache. Waiting for publication instead adds write-permission and publication-time requirements to opening old history. Implementation must choose this behavior rather than using an ambiguous done state for both milestones.

## Alternatives considered

**Push migration progress through global control.** One history-opening operation can own its waiting, failure, and retry without independent global progress synchronization.

**Insert progress before the ordinary history journal's opening frame.** The generic journal remains snapshot-first; the Session adapter consumes redirection and migration frames, forwarding only ordinary history to the journal.

**Automatically replay every RPC that encounters migration.** Commands with committed effects cannot be replayed safely. This proposal covers recoverable history reads rather than a general command-retry platform.

## Acceptance criteria

- The Client shows actual migration phases before receiving the history snapshot; failure remains visible without an automatic retry loop.
- Concurrent joiners, independent waiter cancellation, and reconnect observe the same operation's current state; an old attempt cannot overwrite a new one.
- The resumed history read cannot restart the same migration after cache eviction; cancellation never rolls back a published generation.
- Unknown totals produce no fabricated percentages. Unrelated lightweight requests and progress frames receive execution time during migration, with responsiveness measured separately.
- Create/search, fork/catalog policies, and existing Session data retain their respective guarantees.

## Risks

Redirection spans two requests and needs explicit retention and cancellation ownership. Progress alone does not remove synchronous Host parsing and validation stalls; scheduling changes require measurements. The choice between read preparation and write publication remains an implementation prerequisite.
