---
description: "The provider-neutral model-call service for users and maintainers streaming requests, registering provider adapters, or resolving model metadata."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm` is the provider-neutral model-call service at the center of the harness's LLM capability. Every composition that streams a request to a model provider goes through it, and it owns the shared vocabulary — messages, content blocks, raw stream chunks, and compact Assistant stream records — that the agent loop, session log, and every plugin speak. With it you can register provider adapters, stream one model call, list and discover models, resolve exact-model metadata and call defaults, and capture each provider's retry policy; every request is logged so it stays reconstructable from the session log. It executes no retries and owns no provider wire logic: adapters translate their provider's format, and the optional `dsh-llm-retry` package re-runs failed requests at durable step boundaries. Requests are deep-frozen before dispatch, so middleware and adapters can read them but never rewrite them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Any composition that calls a model provider — an agent loop, a session-title generator, a compaction summarizer — streams its requests through this service. Mount it together with at least one provider adapter; the service itself has no configuration and no provider wire code.

### When to choose it

Choose this package whenever a plugin or composition needs to call a model: it is the only supported path into provider adapters, and it keeps one vocabulary across the loop, the session log, and every consumer. Do not reach for it when you need provider-specific wire behavior (that belongs in an adapter such as `dsh-llm-deepseek` or `dsh-llm-pi-ai`) or retry execution (that belongs in `dsh-llm-retry`).

### Minimal composition

Mount the service and at least one adapter, then select the provider by name in every request:

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
```

A stream returns token-level chunks and always ends with one terminal `finish` chunk. `BlockAssembler` turns the chunks into content blocks and messages; `AssistantStreamAccumulator` preserves their exact timestamps and token boundaries in a compact representation that the loop embeds in one durable attempt settlement:

```text
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }] })],
})) {
  // chunks: block-start, text-delta, ..., usage, finish
}
```

After a successful mount, `ctx.llm.listProviders()` reports the registered routes in registration order.

### What you can do

- **Stream one model call** — `ctx.llm.stream(options)` yields raw chunks (token-level deltas) for any registered provider and model; consumers assemble them with `BlockAssembler`.
- **Register provider adapters** — an adapter owns one or more provider routes, and its registration captures that route's retry policy; registering the same route twice fails with `DUPLICATE_ADAPTER`.
- **Expose and activate providers through configuration** — adapters declare configurable-provider routes plus a settings namespace, so configuration surfaces can activate dormant providers and edit connection facts without a restart.
- **Discover and resolve models** — list the models an adapter advertises, interrogate an endpoint for the models it serves, and resolve one exact model's context window, output default, reasoning efforts, and input modalities.
- **Validate call config** — an explicit or configured reasoning effort is checked against the exact model before any provider I/O, and an adapter-configured output cap is materialized when the request omits one.

### Failures and recovery

Every stream ends in exactly one terminal `finish` chunk: `{ kind: 'error', failure }` on failure, `{ kind: 'aborted', failure }` on cancellation. Failures carry stable codes such as `NO_ADAPTER`, `MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`, and `CONTEXT_WINDOW_EXCEEDED`; consumers route on the code, never on message text. A request naming an unregistered provider fails with `NO_ADAPTER`, and a malformed credential fails with `INVALID_CREDENTIAL` instead of surfacing as an opaque fetch error. This service never re-runs a request: retrying is the job of `dsh-llm-retry` at the agent's failed-step extension point.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the service; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on one separation: **the logical contract is provider-neutral, adapters own the wire.** It defines the canonical message, content-block, and stream-chunk vocabulary once, and every provider adapter translates only its own wire format into that vocabulary. The registry is the topology owner — adapter routes, configurable-provider entries, and discovery offers all register here and are disposed with their fiber — while a request stays a pure function of the session log: loop-built requests arrive deep-frozen, so listeners and adapters read them and never rewrite them.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `LlmRuntime` service: adapter registry, configurable-provider directory, model discovery, call preparation, and the streaming boundary |
| [`src/types.ts`](src/types.ts) | The `StreamChunk` protocol, content-block map, finish reasons, and shared vocabulary |
| [`src/message.ts`](src/message.ts) | Immutable message constructors shared by delivery, history, and requests |
| [`src/assembler.ts`](src/assembler.ts) | `BlockAssembler`: incremental chunk-to-block assembly |
| [`src/assistant-stream.ts`](src/assistant-stream.ts) | Compact timed Assistant stream accumulation, strict validation, and exact expansion |
| [`src/call-config.ts`](src/call-config.ts) | Call-config validation, adapter-default materialization, and request freezing |
| [`src/retry-policy.ts`](src/retry-policy.ts) | Provider-owned retry policy resolution (normal and always modes) |
| [`src/error.ts`](src/error.ts) | `HarnessError`/`LlmError` taxonomy and provider-neutral failure codes |
| [`src/content.ts`](src/content.ts) | Shared image-content helpers, including request-image offloading |
| [`src/api-key.ts`](src/api-key.ts) | Credential format check shared by every adapter |
| [`src/adapter-failure.ts`](src/adapter-failure.ts) | Failure normalization into terminal finish chunks |

### Main flow

A request is validated against its exact model's capability — context window, output default, reasoning efforts, and input modalities — and any adapter-configured defaults are materialized, then the whole request is deep-frozen. `prepareCall()` binds those facts, detached context, and retry policy to the exact adapter generation that performs terminal dispatch, so HMR or dynamic settings cannot combine one generation's image capability with another generation's endpoint. An image-capable adapter projects durable references into route-specific request versions; `resolveImageAttachmentAccess()` separately maps an attachment provider's optional host object into the current tool execution world without changing the request image or its `variantId`. A text-only route receives deterministic per-image placeholders, including nested tool-result images, without rewriting append-only session history. `offloadRequestImagesWithPolicy()` removes oldest images deterministically by raw or base64 size and count or byte quanta; the pure `offloadedImagePrefixCount()` exposes that decision so route-owned request pricing can reproduce it without building the projection. Adapters that charge visual tokens declare per-route `imageRequestPricing`, which `ctx.llm.imageRequestPricing(provider, model)` resolves synchronously for the token meter. Dispatch goes through the `llm/stream` waterfall, then chunks return as token-level deltas and every adapter outcome reaches the consumer as one terminal `finish` chunk.

### Invariants

- **Model-visible ⟺ logged** — anything that reaches a provider request is reconstructable from the session log; loop-built requests are deep-frozen and never rewritten.
- **Replay state travels only within one adapter** — assistant replay state rides along only when the same adapter instance owns the historical and target routes; otherwise it is dropped before dispatch.
- **Prepared calls are one-shot** — a prepared call can be dispatched exactly once, and its call-config fields must match the prepared config.
- **Image projection follows the captured route** — durable `ImageBlock` references become route-specific request versions only for image-capable models; text-only models receive stable placeholders.
- **Protocol ordering** — `usage` precedes `finish`, tool arguments stay raw JSON strings, and nothing follows the terminal `finish`.
- **Registry mutations are atomic** — route and directory registration validates the whole candidate set before anything moves, so a refused change leaves the previous state serving.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared types to the concrete adapters, the retry executor, and the measurement service.

- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the message and block types, compact Assistant stream records, the `StreamChunk` protocol, and the adapter contract.
- [llm-deepseek adapter](../llm-deepseek/README.md) — the direct DeepSeek chat-completions implementation.
- [llm-pi-ai adapter](../llm-pi-ai/README.md) — the pi-ai-backed multi-provider implementation.
- [llm-retry](../llm-retry/README.md) — the retry executor that re-runs failed model requests.
- [Token meter](../token-meter/README.md) — replay-aware request and context pressure measurement.
- [Twin LLM adapters](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) — why the DeepSeek route ships two structurally different adapters.
- [Terminal LLM stream failures](../../../.agents/notes/implemented/architecture/2026-07-29-terminal-llm-stream-failures.md) — the service boundary between model-request outcomes and plugin failures.

-----

<a id="model-experience"></a>
## Model Experience

None, as the LLM service adds no content; adapters choose when to add the shared image descriptors and per-image placeholders exported by this package.

#### KV Cache effect

Reasoning-effort materialization preserves the assembled request prefix. Image identity and request-preview text are deterministic, while an optional execution-world path is resolved for each request; a changed path or image-offload boundary can prevent reuse from that image.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where this service stops and other packages or future work begin. They are current package constraints, not a task backlog.

- **No retry execution, caching, or rate limiting ships in this service** — provider registration stores the retry policy, but a stream remains a single provider attempt; `@deepseek-ai/dsh-llm-retry` executes the policy at durable agent-step boundaries.
- **`GenerateOptions` sampling is `temperature`/`maxTokens`/`stop` only** — no `tool_choice`, `top_p`, or penalty fields; the vocabulary grows when a producer lands ([dropped inert knobs](../../../.agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md)).
- **Producer-gated variants stay out until produced** — `prefill`, per-tool `strict`, block `cache` hints, and the `agent` message-source variant have no producer ([Agent Note](../../../.agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md)).
- **`BlockAssembler` handles core block kinds only** — a plugin-added block type whose stream is never closed by `block-end` makes `blocks()` throw.
- **`GenerateOptions.sessionId` is a locally-declared brand** — importing dsh-session's `SessionId` would create a dependency cycle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and undecided directions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Open items

- `GenerateOptions.sessionId` is a locally-declared brand because importing dsh-session's `SessionId` would create a dependency cycle; a future ids-owning package could dissolve the workaround.
- Reasoning-effort identifiers are adapter-owned opaque strings resolved only against each adapter's advertised set; a shared cross-adapter effort vocabulary is not decided.
- The `llm/adapters-updated` event is payload-free by design; consumers re-read the registries instead of receiving the new topology in the event.

</details>
