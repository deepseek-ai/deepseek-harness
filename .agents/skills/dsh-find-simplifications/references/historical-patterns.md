# Historical simplification patterns

Use these examples to calibrate a candidate whose value is not established by an unused-symbol search. They describe recorded decisions, not current removal opportunities. Archived sources are frozen snapshots: read the cited note itself, never follow or repair its outbound links. Verify current owners and released-data obligations before applying a pattern.

## Require a complete effect path

A declaration, serializer branch, and test can form convincing-looking support without an effective feature. Trace both ends: something must produce the value, and an implementation must honor it. The [producerless-variants decision](../../../notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md) removed reserved union members and cache hints without emitters. The [inert-request-knobs decision](../../../notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md) distinguished knobs rejected by every adapter from working request fields available to hooks. Deletion included declarations, forwarding, rejection-only tests, and generated documentation.

Zero fixed callers is weaker evidence than unreachability. The [skill-registration rejection](../../../notes/rejected/simplification/2026-07-12-prune-unused-skill-registry-api.md) preserves a deliberate third-party registration path. For catalogued services, inspect generic plugin invocation and returned values before calling them dead. A working extension point and a field no provider can honor require different verdicts.

## Reduce distinctions where consumers decide

Map every public variant to the consumer action it enables. The [model agent-availability decision](../../../notes/implemented/simplification/2026-09-15-model-agent-availability-and-team-targets.md) gives models one usable Team target and projects multiple residency states to the same availability, while internal routing retains Session identity and residency. The [capability-neutral sandbox context](../../../notes/archived/simplification/2026-07-31-capability-neutral-sandbox-policy-context.md) replaces two approximate capability registries with truthful conditional policy wording; exact tool availability remains in tool schemas. The gain includes registration methods, disposal state, invalidation, and combination tests.

Do not erase distinct durable facts merely because one renderer ignores them. The [durable step-boundary rejection](../../../notes/rejected/simplification/2026-06-20-drop-durable-step-boundaries.md) retains explicit start and completion facts needed for empty failed steps, crash repair, and inspection. Simplify the projection only when the underlying distinction remains necessary.

## Trade general behavior for a smaller explicit promise

A used feature can still be an expensive way to satisfy the required outcome. The [fixed-rate Schedule decision](../../../notes/archived/simplification/2026-08-09-bounded-fixed-rate-schedule.md) gives up calendar recurrence and missed-occurrence replay, removing a parser, evaluator, cross-record gate, durable variants, and backlog states. The [non-transactional Loader decision](../../../notes/implemented/simplification/2026-09-09-nontransactional-loader.md) gives up automatic plugin rollback while keeping failure reporting and consumer-owned activation checks. Moving generic rollback to another package would retain its cost.

State the loss as clearly as the deletion. The [interrupted-turn truncation rejection](../../../notes/rejected/simplification/2026-06-20-truncate-interrupted-turns.md) rejects a simpler recovery algorithm because an unfinished turn can contain substantial real work. Convenience, smaller unions, or fewer tests alone do not justify losing required data or behavior. A survey can propose the trade-off without implying permission to implement it.

## Make assumptions explicit at their consuming operation

Look for a local default that has acquired shared storage, synchronization, or confirmation machinery. The [explicit Schedule time-zone decision](../../../notes/implemented/simplification/2026-08-09-explicit-schedule-time-zone.md) keeps browser facts on the originating request and requires an explicit zone in the scheduling operation, removing Session defaults and cross-tab conflict state. The [injected-content decision](../../../notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md) leaves framing with the caller and removes envelope controls threaded through unrelated layers. Both reduce the number of owners that must interpret one assumption.

Do not move a requirement past the place that must enforce it. The [Host-only Remote input-validation decision](../../../notes/implemented/simplification/2026-09-15-host-only-remote-input-validation.md) removes duplicate Client schema execution but retains Host validation before lookup and business invocation, plus local arity and Context binding checks. Its documented cost is later malformed-input failure and the loss of Client parsing as accidental redaction.

## Derive at use or reuse an existing delivery owner

For each cache or event subscription, ask when the consumer needs the value and whether an authoritative source already retains it. [Feedback telemetry](../../../notes/archived/simplification/2026-08-06-buffer-free-feedback-telemetry.md) reads the canonical Session prefix at feedback time, deleting a continuously copied pre-feedback buffer and its listeners. [Workspace recency](../../../notes/implemented/simplification/2026-09-10-derived-workspace-recency.md) sorts current summaries instead of persisting promotion history; manual ordering remains independent user state. [Web subagent projections](../../../notes/implemented/simplification/2026-09-08-web-subagent-catalog-projections.md) reuse a shared stream and projection store, removing feature notifications, repeated reads, and a second membership cache.

The timing promise determines whether this works. Feedback-time redaction differs from capture-time redaction; manual placement cannot be derived from activity timestamps; an initial historical read may remain necessary when a stream baseline is absent. Name such residual obligations instead of declaring all caches redundant.

## Remove accidental composition owners

Inspect actual launch and resolution paths before trusting names such as demo, support, or example. The [shared-base-config decision](../../../notes/archived/simplification/2026-07-29-shared-base-config-overlays.md) removes duplicate compositions and pass-through settings; actual Loader behavior determines overlay placement. The [owner-local profiles and guides decision](../../../notes/archived/simplification/2026-08-24-owner-local-profile-tests-and-guides.md) removes a resolver-only workspace by assigning tests, guides, and shipped assets to their owners. The [merged subagent service decision](../../../notes/archived/simplification/2026-07-26-merge-subagent-control-service.md) uses explicit deployment policy instead of inferring it from provider or sibling-tool presence, while preserving optional dependencies internally.

A smaller package count is not sufficient. Separate caller intents may have different ownership and completion timing; a retained Service Definition may serve independent providers. Prove the replacement's real composition and dependency behavior, and account for all remaining configuration and lifecycle glue.

## Use rejected experiments to test parity claims

The [SSE parser replacement](../../../notes/archived/simplification/2026-07-26-eventsource-parser-for-deepseek-sse.md) deletes generic framing and its conformance tests while retaining the provider-specific termination shim and documenting stricter truncated-tail behavior. In contrast, the [timer-promises rejection](../../../notes/rejected/simplification/2026-07-26-builtin-timer-promises-for-hand-rolled-sleeps.md) records that a nominally equivalent builtin defeated deterministic fake-clock tests for a small deletion. The [dependency-swap audit](../../../notes/rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md) distinguishes replaceable generic code from configured bounds, security rules, lifecycle ownership, and deployment behavior a library does not implement.

A past rejection is a scoped falsifier, not a permanent package blacklist. Revisit it only with new evidence addressing the failed premise, and measure the implementation, glue, tests, dependencies, and supported behavior together.
