# Agent Note: Adapter-owned reasoning effort capabilities

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-24-adapter-owned-reasoning-effort-capabilities.zh.md)

## Problem

Reasoning strength was adapter configuration only, so a conversation could not discover or change the selected model's supported levels between requests. Promoting one adapter's level union into `dsh-llm` would make every provider and model adopt names it may not support, while a provider-specific options bag would make the loop unable to validate or durably reconstruct the effective request.

## Decision

`dsh-llm` represents a reasoning effort as the opaque branded `ReasoningEffortId`. One adapter-owned `resolveModel(provider, model, signal?)` query returns `LlmResolvedModelInfo`: exact model identity plus optional context and reasoning metadata. `LlmRuntime.resolveModelInfo()` validates and detaches that aggregate. When present, `reasoning.efforts` is a non-empty ordered list of ids with display metadata and may name one configured default. The core requires an explicit or configured effort to appear exactly in that list and never clamps or aliases a value.

`LlmCallConfig` and `GenerateOptions` carry the optional effort. The agent loop prepares the post-`agent/request` config under the active turn signal before writing `request/header`, so defaults and dynamic changes are model-visible only after becoming durable facts. The prepared call retains the exact adapter registration across asynchronous exact-model resolution, durable header logging, and dispatch; direct `LlmRuntime.stream()` calls likewise capture their final registration before awaiting resolution. A route with no registered adapter retains its proposed config so an `llm/stream` middleware can own and short-circuit it; terminal dispatch still rejects an unhandled route. A resumed loop retains the logged effort only when its initial provider/model route is unchanged; a route change discards the previous model's opaque id.

The native DeepSeek adapter advertises `off`, `low`, `high`, and `max` when deployment policy permits thinking, and defaults to the configured effort or `high`. Its adapter-owned `off` maps to `thinking.type: disabled` with no `reasoning_effort`; `low`, `high`, and `max` enable thinking and carry their same-named official wire effort. A `thinking: disabled` deployment publishes only `off` and rejects attempts to enable thinking before provider I/O. The pi-ai adapter publishes each exact model's `getSupportedThinkingLevels()` result unchanged, including `off`, preserves an absent profile default as a provider default, and leaves provider wire-value mapping inside pi-ai. Its common stream options represent `off` by omitting `reasoning`, as required by pi-ai's own API.

## Alternatives considered

**Define the pi-ai `ThinkingLevel` union in core.** Rejected because current pi-ai canonical names are an adapter implementation detail; a future provider can expose a different identifier without requiring a core release.

**Carry an untyped provider options object.** Rejected because the loop could neither validate a selected value nor put a stable provider-neutral fact in the request header.

**Clamp unsupported levels.** Rejected because a silent substitution makes the user's selected control differ from the logged request intent and hides stale deployment configuration.

**Normalize every adapter to a core-owned level list or remove `off`.** Rejected because the selectable vocabulary belongs to the exact model capability. A client can render an adapter's `off` option without requiring every adapter to expose it.

## Consequences

Clients can query one exact route once and render its identity, context capacity, and adapter-owned reasoning choices without knowing a global enum or synthesizing `off`. Adapter configuration remains the deployment-default and policy owner, while `agent/request` can replace the effective effort on each step within that policy. Invalid exact identity, context, or reasoning metadata fails with `INVALID_MODEL_INFO`, `INVALID_MODEL_CONTEXT`, or `INVALID_MODEL_REASONING`; unsupported explicit or configured values fail with `UNSUPPORTED_REASONING_EFFORT` before provider I/O.

The aggregate exact-model query is asynchronous and may fail for adapters backed by authoritative catalogs. Its optional signal is the caller's cancellation boundary; an asynchronous adapter must settle promptly after abort so loop disposal can reach quiescence. Keyless service, adapter, loop, session, and request-header tests pin validation, defaulting, dynamic changes, logging, resume behavior, HMR registration ownership, and cancellation; runnable snapshots pin the resolved effort in real assembled request headers, while key-gated adapter tests exercise provider serialization.
