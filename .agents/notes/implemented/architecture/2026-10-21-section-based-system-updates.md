# Agent Note: Section-based system updates

Status: implemented

English | [中文](2026-10-21-section-based-system-updates.zh.md)

## Problem

Whole-prompt updates repeat unchanged instructions whenever one contributor changes. Separate contributor state, retirement queues and provisional admission records duplicate lifecycle and commitment facts, while process-local comparison loses resume and fork history. Scope overrides must change effective instructions without retiring a logical source that still has a live owner.

## Decision

`section()` is the sole source registration API. A name identifies logical instructions; ordinary `system/message` events record their canonical text, order and state. The per-Session projection of those events is the committed authority. Runtime definitions remain shared because deployment and preset plugins can register before Sessions exist. The Session supplies its own committed state and callback context.

### Registration and retirement

Each Cordis effect owns one registration. Assembly chooses the nearest visible scope, then the latest live registration in that scope. The selected definition supplies text, order, replacement wording and complete mode; only its text provider is evaluated. Removing a hidden owner cannot remove its override. Removing an override reveals an inherited definition as an ordinary update. Persona prefix and suffix use these same registrations: prefix text and complete mode inherit together, while suffix inherits independently, including for subagents.

Retirement requires both no live registration in the visible chain and committed text for that name in the Session. Each Session retains the definitions it observed; the last disposed observed registration supplies its literal retirement wording, or the service supplies a notice naming the source. Neither explicit disposal nor plugin teardown evaluates a disposed provider. One Session completing retirement cannot erase another Session's notice. Committed retirement removes the source from the projection, so later reintroduction is an ordinary introduction.

Disposal records lifecycle state rather than another contribution. Off/on cycles before assembly send nothing when effective text and order are unchanged. A source never committed needs no retirement; inactive references can be released once that Session no longer has committed text. Independent instructions that need separate retirement use different names.

### Canonical records and fixed assembly

Assembly captures source values and lifecycle state before asynchronous presentation middleware. Its final normalized presentation fixes the sections; the loop obtains their updates at commitment, where they are compared with the committed projection. Text is interpolated and trimmed before direct comparison; numeric order and name determine ordering, and order-only changes are logged. Canonical text and each notice occupy separate trimmed text blocks. Adapters own separators, so whitespace added for serialization is not a source contribution.

`source.sections` attributes canonical blocks and notices without parsing their prose. Active records have `contentIndex`, including an empty string; retired records omit it. Optional `noticeIndex` lists replacement or retirement blocks without classifying notice kinds. Indexes refer to the containing message and cannot overlap or repeat. Whole-prompt supersession notices remain unattributed because they concern several sources. Notices are model-visible and logged but excluded from canonical comparison. [Session-format rules](../../../../docs/session-format-status.md) govern durable validation.

Blank initial ordinary sections contribute no attributed text. Making an admitted source blank is a text change that withdraws its guidance, not disposal. The first accepted assembly reserves a system head even when empty; empty content remains logged and addressable but produces no model-request message. Entering or changing a complete prompt appends explicit supersession and reset semantics; leaving it reintroduces current ordinary sections. A system message without `source.sections`, written by an earlier release, a format migration or an importer, receives no invented source metadata; it marks [rebuilding](2026-11-09-deferred-system-compaction.md) pending. Otherwise earlier messages keep their positions.

Rejected or cancelled preparation commits nothing. A later assembly compares current values against committed events again. Once messages are appended, cancellation does not undo them. Source changes after capture wait for the next assembly: disposal can follow a captured introduction, which then commits and is retired on the next assembly. This accepts occasional redundant introduction and retirement rather than losing withdrawal or adding a second observation point. Retries reuse the accepted assembly without another delta commit. After [compaction](2026-11-09-deferred-system-compaction.md), the same captured sections produce a full rebuild at the next model attempt.

Ordinary route, tool, request-series and restart changes do not consolidate instructions. This preserves the [unchanged-prefix guarantee](../bug-fix/2026-10-22-series-start-unchanged-prompt-prefix.md) and the timing of guidance. All retained system messages count as system tokens; adapters preserve additions through native system messages, reminders or a combined system field. The [surface-node representation](2026-09-02-system-prompt-as-surface-node.md) remains the durable representation.

Plan mode retains conditional policy and changes a separate status section on exit and reentry, avoiding repeated policy text. User-switch notices follow committed user-selected transitions, not request headers: headers describe request configuration and need not change with system sections. Cancelled selections emit no notice; approved tool exits use their tool result. Initial entry and committed idle transitions are announced without a second last-announced mode.

## Alternatives considered

**Parallel source APIs and mutable admission fields.** The examined #4969 design supports arbitrary state and declared exits, but text comparison covers this feature. Last-admitted and last-committed fields duplicate candidates and the event-derived projection, adding synchronization for rejection, cancellation and replay. Process-local last-text caches also forget resume and fork state.

**Explicit retirement calls, polling or pending-notice queues.** Producer cleanup was initially preferred to avoid a service-owned liveness detector. Cordis already invokes exact registration cleanup, so registration-time literal wording supplies the same signal without cleanup-time service access. Selecting retirement during assembly coalesces re-registration without a second queue or cancellation mechanism.

**Reject duplicate names or retire every disposed owner.** A single owner avoids fallback rules but prevents scoped overrides. Retiring each owner withdraws instructions that an inherited definition still supplies. Explicit scope precedence and logical-source retirement resolve both cases; duplicate names no longer detect accidental double loading.

**Last registration wins globally or one service per Session.** Global load order would let a late deployment reload override more specific agent instructions. Session-local services would still need to route earlier shared registrations and later disposal, or duplicate plugins and their resources per Session. Shared scope layers with per-Session committed state avoid both problems.

**A dedicated persona registry.** Ordinary sections already resolve prefix and suffix independently, carry complete mode, and restore inherited definitions on disposal. Another registry and assembly overlay duplicate those rules.

**Late source evaluation, retry reevaluation or per-source digests.** Evaluating sources late changes the fixed observation point and an already accepted candidate. Hashing adds recurring work and another representation without eliminating canonical text storage. Direct comparison uses the text already needed for recovery.

**Remove plan policy on exit or rebuild on every restart.** Persistent conditional policy avoids resending it on reentry. Restart rebuilding would move current instructions ahead of intervening turns and discard their original timing. Compaction deliberately permits that movement under its separate decision.

**Persist uncommitted retirement definitions.** Recovery would need stable scope identities, durable cancellation on re-registration and shutdown flushing after cleanup. The runtime-only design accepts the recovery gap rather than adding those mechanisms.

## Consequences

The projection grows with effective sources rather than conversation length and avoids per-request history scans; checkpoints are discardable replay optimizations. Unchanged sections are not duplicated, but retained instructions and notices still consume context. Prefix reuse depends on adapter representation and is not guaranteed. Arbitrary non-text transition state is outside this feature.

Runtime definitions and uncommitted disposal state do not survive restart. A resumed or seeded Session cannot recover registration-specific retirement for a source it never observed locally and that never registers again. This also affects a fork seeded from a completed-turn prefix after its parent retired and released the source during an excluded open turn; copying the parent's current map cannot recover that historical definition. Ordinary admission does not automatically retire missing sources or retain historical definitions. Startup and inherited-source recovery remain deferred; compaction instead adopts current live sources.

Focused registration, assembly and loop tests cover exact-owner teardown, fallback, per-Session retirement, discarded candidates, disposal after capture, reentry, persona inheritance and retry reuse. Persistence and request reconstruction verify canonical metadata and exact model-visible blocks through replay. The compaction note owns rebuilding coverage.
