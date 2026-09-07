# Agent Note: Model-relative session-reference budgets

Status: implemented

English | [中文](2026-09-05-session-reference-model-budget.zh.md)

## Problem

A fixed 64 KiB reference budget discards useful source context on large-context models. The target session header describes a prior request, while agent options seed routing; neither necessarily identifies the model selected for the entering step.

## Decision

[Session-reference](../../../../packages/context/session-reference/README.md) observes the completed `system-prompt/assemble` waterfall with a local prepend listener and stores its provider/model pair in a WeakMap keyed by Agent. Preparation resolves that route through the optional LLM service; direct preparation before any assembly uses agent options. Diagnostics without an Agent do not update the map.

Each source receives `max(65536, floor(contextWindow × 4 × referenceContextFraction))` bytes, with a default fraction of `0.2`. Four bytes per token is a sizing heuristic. Explicit `maxReferenceBytes` bypasses model lookup and remains exact. Missing route, service, adapter, or capacity retains the floor; other lookup failures and cancellation propagate. An absent adapter does not prevent stream middleware from serving the route.

## Alternatives considered

**Read the header or options for every step.** Either can select a stale model after a live switch. The completed assembly exposes the route captured by model selection.

**Reassemble or redispatch request routing during pre-step.** These operations repeat plugin effects and can capture a different selection. A local observer needs neither loop changes nor another public routing API.

## Consequences

The budget grows with model capacity without changing projection, retention, or preview policy. It remains per source, not an aggregate token reservation. The listener is effect-owned and disposable; the map does not retain agents. Focused tests cover the floor, fractional conversion, explicit overrides, live selection, absent metadata, cancellation, lookup errors, and listener removal.
