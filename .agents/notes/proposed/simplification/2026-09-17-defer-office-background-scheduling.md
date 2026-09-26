# Agent Note: Defer Office background scheduling until a consumer needs it

Status: proposed

English | [中文](2026-09-17-defer-office-background-scheduling.zh.md)

## Problem

The [conversion queue](../../../../packages/document/office-to-pdf/src/queue.ts) implements foreground promotion, demotion after reader cancellation, eviction of queued background work, a reserved foreground reader allowance, and separate background concurrency accounting. These mechanisms protect foreground conversion from speculative prewarming; ordinary conversion still needs the queue's general resource limits.

The [Office preview](../../../../packages/client/ui-sidebar-documentpreview/src/client/office/index.ts) calls its cache without a priority argument, so the [Client cache](../../../../packages/client/ui-sidebar-documentpreview/src/client/office/cache.ts) forwards the default foreground priority to the Host. Repository searches for `officeToPdf`, `OfficeToPdfRequest`, `OfficeToPdfPriority`, and `maxBackgroundConversions` find no production background request. The [conversion smoke](../../../../packages/bundle/web-app/tests/document-conversion.e2e.ts) also submits foreground requests. Background requests appear in queue, Remote, and Client-cache tests. The exposed API and Client priority plumbing alone do not establish which scheduling policy prewarming requires. The open delivery prewarming PR #4064 already provides a concrete prewarming consumer, but its implementation calls the older `documentRender` API without priority. Removing scheduling must first be reconciled with that consumer; absence from master is insufficient evidence to proceed.

The [bounded conversion decision](../../implemented/architecture/2026-09-15-bounded-office-conversion.md) deliberately reserves capacity for foreground consumers. That remains the correct rule if speculation exists, but the current caller inventory does not justify maintaining the speculative request class and its lifecycle interactions.

## Proposal

Remove `OfficeToPdfPriority`, request `priority`, and configuration `maxBackgroundConversions`. Remove reader/job priority fields, promotion and demotion, speculative eviction, foreground reader reservation, and the queue's background counter. Remove Client-cache priority plumbing and update the Remote signature together. Admit the oldest queued job whose source reservation fits whenever conversion capacity is available; reject a new distinct job when the metadata queue is full. Continue joining an existing source job subject to the shared reader limit.

Keep the provider, reusable converters, deferred authorized reads, all remaining resource limits, source-version checks, content sharing, bounded result cache, independent reader cancellation, and teardown that waits for actual work to settle. This proposal changes admission policy, not conversion ownership or engine selection.

Update the request/config definitions, package README pair, subsystem and generated catalogs, and conversion fixtures together. Delete priority-only assertions; retain resource and cancellation regressions embedded in mixed priority tests by expressing them with ordinary requests. The existing bounded conversion note remains active because its cache, authorization, and lifetime rationale still applies; acceptance would replace only its scheduling policy.

## Alternatives considered

**Keep priority for a future prewarm consumer.** This avoids a later API change, but retains scheduling states and configuration before a product consumer can define their required behavior. Reintroduce priority with a concrete prewarming caller and measured foreground contention.

**Disable background conversions by default.** This avoids speculative execution but retains the public request class, configuration, and all scheduling branches.

**Remove the whole shared provider or cache.** That exceeds the evidence: independent conversion and bounded sharing remain coherent capabilities, and the Loader smoke exercises them without presentation plugins.

## Acceptance criteria

- Resolve the scheduling needs of delivery prewarming PR #4064 before implementation, then repeat the caller search. Retain priority if that consumer needs foreground protection; do not remove it merely because the consumer has not merged.
- Priority types, fields, configuration, and scheduling branches disappear from maintained source, tests, documentation, and generated catalogs. Decision records may describe the removed policy.
- Focused queue/provider tests preserve bounded admission, source/digest sharing, cancellation isolation, output ownership, and delayed capacity release. The real conversion Loader smoke still passes.
- Verify the foreground Office preview path; update its recorded-session snapshot if affected. Run the relevant type checks, generated-reference checks, documentation checks, and lint.

## Risks

Out-of-tree callers can use the exposed pre-stable API even though repository searches find no background consumer. Removing priority and its config field requires callers to update; this proposal offers no compatibility alias. Speculative callers would lose foreground protection and must stop prewarming until an explicit scheduling requirement is implemented. No runtime behavior changes until this proposal is accepted and implemented.
