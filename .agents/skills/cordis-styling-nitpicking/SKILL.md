---
name: cordis-styling-nitpicking
description: Use during code review of DeepSeek Harness Cordis plugins and helpers reachable from their entrypoints, including pull requests, and during focused lifecycle audits. Checks singleton state, unreversed side effects, and cleanup dependencies released before consumers finish; reports substantiated P0 findings with ownership evidence and deterministic verification.
---

# Cordis Ownership and Lifecycle Audit

This is a focused semantic review of Cordis ownership and lifecycle. Start a repository audit from exported plugin entrypoints (`apply` or a concrete default export invoked by Cordis), then trace module initialization, registered services, listeners, effects, disposers, and transitive calls reachable from those roots. Exclude unrelated helpers, build tools, CLI paths, and tests as finding targets. Read tests and vendored Cordis to establish behavior; report a generated defect against its owning source. Do not report defects in vendored code under this skill.

## Sources of truth

- [Repository conventions](../../../AGENTS.md): Cordis ownership requirements.
- [Lifecycle and effects](../../../docs/cordis-tutorial/02-lifecycle-and-effects.md): effect acquisition and disposal.
- [Services](../../../docs/cordis-tutorial/03-services.md): dependency tracking and service availability.
- [Defensive patterns](../../../docs/defensive-patterns/general.md): quiescent teardown and required completion listeners.

## Review workflow

1. Locate mutable owners, registrations, resource acquisition, and work admission reachable from the requested plugin roots. For large scopes, use independent directory scans, then consolidate findings involving the same consumer and resource.
2. Trace ownership through the actual context: in a traceable service method, `this.ctx` is the caller's context. Identify who owns each effect and the disposer that releases it.
3. Trace cleanup through every await to its last service call, emitted event, acknowledged operation, and durable write. Include indirect event delivery and cleanup performed after abort, kill, or cancellation.
4. Compare consumer completion with the time each required listener, registry, writer, connection, domain, or transport becomes unusable. Inspect the current Cordis implementation; reverse start order and dependency registration alone do not establish completion order.
5. Establish a legal failing interleaving and observable impact. Check existing cancellation, explicit sequencing, and documented discard semantics before reporting. Use controlled promises for reproduction where feasible, and label source-only findings accurately.

## P0: singleton pattern

Flag one process-wide instance or mutable state owner whose identity or lifetime comes from module loading, a static field, a global symbol, a hidden cache, or a `getInstance()` accessor. Weak keys, size bounds, generation checks, and behavior-preserving memoization do not give a module-level cache Cordis ownership.

Exclude immutable scalar constants, pure frozen tables, stateless functions, and objects allocated inside an explicitly scoped owner. Recommend a Cordis service and declared or otherwise resolved consumer dependencies; use a scoped context or service-owned keyed record for narrower lifetimes.

## P0: unreversed side effect

Flag an owner that leaves a live effect behind after disposal: listeners, registrations, timers, watchers, child fibers, processes, connections, temporary files, subscriptions, ambient patches, or asynchronous work. Aborting or killing without awaiting settlement is a violation when cleanup can return before owned work stops.

Correctly owned `ctx.on()`, `ctx.plugin()`, and `ctx.effect()` registrations already provide reversal; callers need not retain their early disposers. Unmanaged resources need an owned effect or explicit awaited cleanup. Do not demand rollback of intentional durable writes or remote mutations; temporary and live resources used by those operations still need owners.

## P0: cleanup dependency released before consumer completion

Any service call or event delivery required to finish cleanup is a lifecycle dependency. Keep its actual resources and listeners usable until the consumer has settled, including final result publication and durable writes. A provider's disposal promise finishing after consumers does not prove its resources survived their cleanup.

The current [fiber unload](../../../vendor/cordis/src/fiber.ts) starts sibling disposers concurrently. [Service withdrawal](../../../vendor/cordis/src/reflect.ts) awaits dependent fibers inside its own disposer, while sibling resource closers can already run. Adding `inject`, reversing registration order, or retaining a service reference does not fix that race. A listener can also belong to the consumer fiber and auto-unsubscribe alongside an operation's drain.

Require explicit ownership and awaited sequencing: stop admission, settle admitted consumers while their dependencies remain usable, then drain and release the resources. Scope new-admission rejection separately from completion of accepted operations. Use an explicitly composed effect or a resource-owning parent with an awaited consumer/service child; verify the actual captured disposer identities. `ctx.effect(function* ...)` serializes the disposers it collects, but a wrapper around an independently registered effect does not transfer ownership of the original effect. Top-level plugin generator yields are not a general promise of serial sibling disposal. Check failure paths as well: one cleanup error must not skip required abort, settlement, or resource release.

### Current workaround: function plugin with yielded effects

Use a function-style provider plugin with one `ctx.effect(function* () { ... })` to compose service publication and resource effects. Yield the exact disposers returned by the registrations so the composed effect takes ownership of them:

1. Acquire the resources and required completion listeners, then `yield` each registration's returned disposer. Register resource cleanup with `ctx.effect()` and yield that exact returned disposer too.
2. Publish the service last with `yield ctx.provide(name, service)`. Reverse disposal then withdraws the service and awaits the dependent consumers still registered with Cordis before disposing the earlier resource effects.
3. If the provider needs a separate admission gate, yield its cleanup last so disposal stops new admission before withdrawing the service. Keep accepted cleanup operations usable while consumers finish.

This orders provider withdrawal while its consumers remain registered; it is not a complete enclosing-owner shutdown fix. Consumer disposal removes a fiber from the registry before its cleanup finishes, so service withdrawal can miss an already-disposing consumer. For root or enclosing-owner disposal and independently started consumer cleanup, retain and await the actual consumer disposal tasks through an explicit owner before releasing their resources.

Put these yields inside the composed `ctx.effect()` generator, even when the plugin itself is a generator. Top-level plugin yields alone leave disposers as concurrent siblings in the current implementation. Do not yield replacement wrappers around already registered disposers: the original effects would remain independently owned and could still close early. This workaround orders the captured effects; it does not repair uncaptured consumer-owned listeners or remove the need to handle cleanup failures.

Do not report missing injection alone, a merely possible late call with no reachable consumer, or intentional suppression of optional notifications. Required persistence and completion observers must not be treated as optional notifications.

For a regression, pause the consumer immediately before its last dependency use, start provider or enclosing-owner disposal, verify the resource and required listeners remain usable, then release the consumer. Assert its actual terminal result and durable output, and assert disposal stays pending until completion. Cover provider unload or replacement as well as consumer-only cleanup; call counts and idle happy-path disposal are insufficient.

## Reporting

Report only substantiated P0 violations of the three rules above. Give a tight source location, plugin root, consumer and resource owner, failing interleaving, observable impact, correction, and deterministic acceptance test. Consolidate multiple locations implementing one failure. State the inspected scope, rejected candidates, and reproduction limits; do not claim exhaustive safety from a pattern search.

If asked to record unresolved findings, use proposed Agent Notes with rationale, alternatives, acceptance criteria, risks, and an active-note supersession check. Otherwise return the findings directly. If no violations are established, say that no P0 violations were found in the inspected scope and identify any material evidence gaps. When a caller supplies a structured output schema, use that schema with these rule names and severities; report conflicting rule instructions before executing an automated audit.
