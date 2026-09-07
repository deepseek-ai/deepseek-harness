# Agent Note: Architectural conformance — dependency rules and the adapter kit

Status: rejected — premise gone: plugins depend on dsh-agent-loop by design; dsh-llm/invariant and the hygiene dependency gates own conformance

English | [中文](2026-06-11-architectural-conformance.zh.md)

## Problem

Two architectural guarantees currently live only in prose: (1) nothing depends on the concrete loop package ([the microkernel promise](../../implemented/architecture/2026-06-11-microkernel-event-taxonomy.md)), and (2) every LlmAdapter speaks the chunk protocol correctly. Both should be mechanical ([the quality-gates principle](../../implemented/process/2026-06-11-quality-gates.md)).

## Proposal

**dependency-cruiser** with rules:

- `packages/*` (except agent-loop's own tests and examples/) must not import `@deepseek-ai/dsh-agent-loop`.
- No cross-package deep imports (`@deepseek-ai/dsh-*/src/...` paths) — public entry points only.
- No import cycles anywhere in packages/.
- `vendor/*` must not import from `packages/*`.
- Layering: dsh-llm imports nothing from other dsh packages; dsh-session only dsh-llm; etc. (the dependency table in packages/README.md, enforced).

**Adapter conformance kit** in dsh-llm (`@deepseek-ai/dsh-llm/conformance`): a reusable vitest suite parameterized by an adapter factory, asserting the chunk-protocol contract — index monotonicity per block, no deltas after `block-end` for an index, exactly one `finish`, usage at most once, every `tool-call-delta` carries the call id, abort honored promptly. Run it against the mocks now; the DeepSeek V4 adapter inherits it on day one. Optionally a dev-mode `strictAdapter()` wrapper enforcing the same at runtime behind a debug flag (pairs with [the dev-mode invariants](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md)).

## Plan

dependency-cruiser config + CI step first (an hour of work, permanent guarantee); the conformance kit lands with its first consumer test against MockAdapter, and is a prerequisite for the V4 adapter phase.

## Acceptance criteria

- dependency-cruiser runs in CI with the rule families above; a violating import fails the build.
- The conformance kit runs against the mock adapter and both shipping adapters, and a new adapter package inherits the suite by invoking it with its factory.

## Risks

Dep-cruiser rule maintenance as packages are added — keep rules pattern-based (`dsh-*`) rather than enumerated.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
