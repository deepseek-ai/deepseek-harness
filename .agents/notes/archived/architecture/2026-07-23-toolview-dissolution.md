# Agent Note: Toolview dissolution — tool rows are per-view keyed slots

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-23-toolview-dissolution.zh.md)

> Scope: why the standalone tool ring (ToolViewRegistry/ctx.toolviews/outlet) was retired and what replaced it. The [web client architecture note](2026-07-19-gui-web-client-architecture.md) carries the shipped-state narrative this decision produced; the [slot system standard](2026-07-22-slot-type-chain-implementation.md) owns the registration model everything now runs on. The later [Client Tool presentation ownership](2026-08-08-client-tool-presentation-ownership.md) decision supersedes only this note's per-view placement: Tool-name dispatch remains a keyed slot rather than a parallel registry.

## Problem

After the view ring dissolved into the slot system, the client kept exactly one parallel registration model: the tool ring — a named registry (`ctx.toolviews`) with its own register grammar, its own resolve semantics (scoped-beats-global predicate dispatch), its own subscribe/version pair, its own inject cache, and its own render outlet with a private error boundary. Every one of those was a second implementation of something the slot machinery already owned, and every future capability (a store seat for row drafts, i18n injection, cross-bundle identity) would have had to be built twice or drift. The ring's one honest justification was that tool names are a runtime-open set while `SlotMap` is a closed declaration table — a registry keyed by arbitrary strings seemed structurally necessary.

## Decision

The tool ring is gone as independent infrastructure: a tool row is a **keyed child slot each view declares for itself**, and the client has exactly one registration model. The justification above was hollow — a keyed slot's *key space* is already runtime-open (SlotMap declares slots, never keys; the ask-user composer's `key: 'question'` was the precedent), so the open tool-name set fits `entryKey` dispatch natively.

This decision originally placed `'conversation.chat.toolview'` under the chat entry and made the chat render site dispatch each row. The follow-up [Tool presentation ownership](2026-08-08-client-tool-presentation-ownership.md) moves that placement into a whole-Tool seat and gives `ui-tool` one keyed `'tool.call.toolview'` child slot. That follow-up changes the presentation owner, not this decision's core constraint: Tool registration continues to use ordinary keyed-slot machinery, with framework-owned activation, replacement, caching, error isolation, versioning, and fallback behavior.

## Accepted semantic changes

Four behavioral deltas were accepted deliberately, not overlooked. Cross-view appearance was initially per-view registration; the follow-up note records why root/subcall composition later justified one Tool-wide presentation owner. Same-key double registration is a loud throw where the registry let later-wins silently override — a discipline correction, not a loss. Session-dimension dispatch, when a row needs it, belongs inside the component (the standard kit already carries `useSessions`), not in registry predicates — there is no shipped session-variant exemplar. Registry-level shape override by third parties (a scoped registration shadowing a global one) has no equivalent; a real future need routes through key-naming conventions or a small in-component resolver, never a revived parallel registry.

## Alternatives considered

**Keep the standalone registry (the original shape).** Rejected: each of its multi-dimensional dispatch axes has a more correct home — presentation ownership belongs to an explicitly declared child slot, and the session dimension belongs inside the component, which already holds the standard kit. What remains is a second copy of slot machinery with no distinguishing capability.

**Promote `renderToolView` into the standard kit and move the registry into the runtime package.** Rejected: Tool presentation is Client UI vocabulary; hoisting it into runtime would leak presentation into the data object layer and still leave two registration models.

**Derive slot declarations from subscription refCounts** (declare the slot implicitly when the first registrant subscribes). Rejected for implicit coupling and debounce complexity; noted as a possible revisit only if a genuinely multi-viewer UI appears.

**A thin `registerToolView` facade over slots.register.** Deferred, not rejected: after dissolution the facade would carry only compile-time sugar (slot-name literal narrowing, tool→key vocabulary, props pre-composition) with zero runtime. Per "enforce at the operation boundary" (a facade is not an enforcement point), it stays unbuilt; the useful type composition ships as the exported Tool view props alias. A later facade can be added without disturbing direct registration if repeated registration ceremony justifies it.

## Consequences

The client has one registration model; auditing who renders Tool calls means reading slot register calls, the same audit as every other slot. Registrants get the framework's error isolation, inject caching, and store seat for free — no capability ships twice. The costs are the accepted semantic changes above, chiefly loud duplicate-key failure and no third-party registry-level override. Independent registrants name the typed slot in `ctx.slots.inject`, so the dependency is explicit and follows declaration replacement without a service-order convention.
