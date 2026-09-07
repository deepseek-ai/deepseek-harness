# Agent Note: Agent-scoped events dispatch a single payload object

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-agent-event-payload-objects.zh.md)

## Problem

Agent-scoped events historically took positional arguments: a leading `agent` subject, event-specific fields, and a trailing `next` for waterfall/serial events. Adding a field or retiring a context type (as with `PreStepContext` and `RequestFailureContext`) rewrote every listener and emitter across packages, and the contract stayed spread across the parameter list instead of one named payload.

## Decision

Every agent-scoped event takes exactly one payload object as its first argument. The payload always carries the subject (`agent`), the event's fields, and the cancellation `signal` when the event has one; `next` remains the last argument of waterfall/serial events. The affected events are the twelve `agent/*` events, `agent-loop/config-start-failed` (the only one without a subject), and `goal/changed`.

`PreStepContext` and `RequestFailureContext` are retired; their fields live directly in the `agent/pre-step` and `agent/request-error` payloads.

Dispatch is fused: `agentEvents(ctx, agent)` (and the one-shot `emitAgentEvent`) injects the subject so the scope carrier key and the payload's `agent` cannot diverge, and the injected subject wins even over a structurally acceptable payload that happens to carry an `agent` field. `ReactLoopAgent` builds its dispatcher once in the constructor and routes every emit, serial, and waterfall through it, so hot-path dispatches allocate nothing.

## Alternatives considered

**Keep positional signatures.** Adding a field or retiring a context type would keep rewriting every listener and emitter, and the contract would stay spread across the parameter list instead of one named payload.

**Hand-build the subject at each dispatch site.** The loop's intermediate design called `ctx.waterfall(this.carrier, …)` with a manually constructed `{ agent: this, … }` payload; it avoided per-dispatch allocation but duplicated the subject injection and let the scope key and the payload subject diverge. The fused dispatcher is the single injection point for every dispatch mode.

## Consequences

Listener signatures name the full payload once, so extending a payload or retiring a context type is a one-shape change across all listeners and emitters. The subject/scope coupling is enforced by the dispatcher for every dispatch mode, and the loop's hot paths stay allocation-free.
