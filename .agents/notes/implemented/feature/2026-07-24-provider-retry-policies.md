# Agent Note: Per-provider request retry policies

Status: implemented

English | [中文](2026-07-24-provider-retry-policies.zh.md)

## Problem

One process may route model requests to providers with different reliability and cost constraints. A single transient classifier and finite retry budget cannot express a deployment that wants bounded recovery for most providers but requires one provider to keep retrying every model-request failure until the request succeeds or the caller cancels it.

Provider policy must follow the request that actually failed, including a route selected by `agent/request`, rather than the agent's initial options. Unbounded policy also cannot store JavaScript `Infinity` in the durable session event, and neither provider error text nor discarded partial output may enter the next model request.

## Decision

Each concrete adapter accepts an optional `retryPolicy` inside its provider configuration, validates and resolves it, and exposes that resolved route policy through `providerRetryPolicy()`. Omission selects the shared core normal default of five retries for every composition, including Web, headless, and custom profiles. The effective policy remains route-owned registration state rather than a retry-executor setting. Layered settings may retain normal-only `maxRetries` or `retryableCodes` after changing `mode` to `always`; the resolver ignores those inactive fields while still rejecting unknown keys, and the registered always policy omits them. When a call enters its final adapter boundary, `ctx.llm` binds the serving registration's immutable policy to that call; the agent loop passes it to closed-step recovery even if the route is disposed or replaced while the request is in flight. `@deepseek-ai/dsh-llm-retry` combines that call-local policy with the failed step's durable provider identity. A call that never reaches a final adapter has no serving policy and delegates.

```yaml
providers:
  - provider: deepseek
    retryPolicy:
      mode: normal
      maxRetries: 2
      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
  - provider: internal
    retryPolicy:
      mode: always
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2
```

The listener reads the provider from the durable `request/header` in force when the failed step closed, excluding later recovery mutations, but never re-resolves policy from the mutable provider registry. It derives a canonical key from every field of the resolved serving policy, sorting `retryableCodes` because eligibility uses set membership, and continues retry history only for the same provider and key. Replacing a route with different limits, code membership, or backoff therefore starts a new count and initial delay even when the mode is unchanged. Normal mode retains the bounded transient behavior: it retries configured codes up to `maxRetries` and otherwise delegates.

Always mode asks downstream recovery first so a specialized policy such as context-overflow compaction can make progress. A downstream retry wins. A downstream failure decision or thrown recovery error falls back to an unbounded retry of the same provider request; the thrown error is logged. The retry listener owns and drains delegated recovery before cancellation or plugin disposal can finish, then applies the abort instead of a late downstream decision. Success, turn cancellation, and plugin disposal are the only termination paths.

Both modes use exponential local delays from `initialDelayMs` to `maxDelayMs`. `jitterRatio` multiplies each target by a uniform sample in `[1 - jitterRatio, 1 + jitterRatio]`, then applies the cap. A positive provider `Retry-After` within the cap remains exact and unjittered. An over-cap provider delay makes normal mode delegate; always mode retains its guarantee by using the configured local backoff.

Each scheduled retry appends a non-surface `llm/retry` event with the failed provider, policy mode, canonical resolved-policy key, provider-policy retry number, delay, and failure facts. Normal events carry finite `maxRetries`; always events omit it, and UIs render the limit as `∞`. Neither that event nor the failed attempt's `assistant/attempt` settlement contributes a surface message, so the next request contains the same derived context as the failed request unless another recovery policy deliberately changes the surface.

## Alternatives considered

**One retry-executor-level `always` switch** — rejected because it cannot isolate the unbounded cost and latency risk to the provider that needs it and can silently apply after runtime rerouting. Provider route policies remain authoritative, and the effective policy is captured only after routing selects a registration.

**A separate exact-provider list on `dsh-llm-retry`** — rejected because it duplicates provider route names outside their owning adapter configuration and lets provider registration drift from recovery policy.

**A very large finite retry count** — rejected because it eventually violates the requested keep-retrying contract and serializes an arbitrary operational limit as if it were meaningful.

**Adapter-specific omission defaults** — rejected because a shared budget would have to be repeated by every adapter family and every future adapter, making equivalent model routes behave differently depending on their implementation.

**An LLM deployment-level default** — rejected because it introduces another configuration layer only to make Web differ from other compositions. The product default is uniform, while provider settings retain the existing per-route override.

**Stamp five retries into profiles when the Web UI writes them** — rejected because existing profiles, settings written outside that UI, and non-Web compositions would retain the old value.

**Provider-SDK retries** — rejected because hidden attempts multiply agent-level budgets, cannot use the closed-step durability boundary, and may splice or discard streamed output without a reconstructable retry record.

**Put the error into model context** — rejected because a transport or provider diagnostic is operational state, not conversation content. It can expose sensitive provider details and changes the retried request instead of repeating the failed request.

## Verification

Adapter tests validate nested policies at provider load, prove explicit profile policies reach registration, prove omission resolves to five retries, and retain the serving policy across in-flight route replacement. LLM service tests prove adapter policies are captured and omission uses the shared five-retry behavior. Resolver tests prove always mode ignores retained normal-only fields but returns a pure always policy. Unit tests select policies from the failed request's serving registration, separate provider and changed-policy histories, exercise always mode beyond the normal budget, pin jitter and delay caps, prove downstream recovery ordering, prove cancellation and disposal drain delegated recovery before reaching quiescence, and prove both abort active backoff waits. Request-level coverage compares the complete messages of failed and retried attempts and rejects both provider error text and discarded partial output. A keyless headless `stream-json` snapshot runs failure, retry, and success through the assembled app, pins the complete `llm/retry` record, and rejects any model-message change between attempts. The shipped Web composition snapshot pins omitted DeepSeek and pi-ai policies at five retries, then proves settings can write `{ mode: 'always', maxRetries: 5 }` and obtain a pure always policy. A JSONL test round-trips an always event without `Infinity`; invariant tests bind provider identity to the request header, validate failure and mode-specific timer bounds, and bind retry numbers to provider-policy keys; TUI tests render finite and infinite limits.

## Consequences

Normal mode remains a finite default, while an explicit always policy can spend unbounded requests and time on permanent authentication, quota, invalid-request, protocol, or context failures. Operators must pair always mode with a cancellable caller and provider-specific cost controls. Any model route using omission defaults may spend up to three more requests and their backoff time than under the former two-retry default, in exchange for recovering from longer transient outages. Retry state stays observable and durable without becoming model-visible, and serving-registration capture prevents adapter lifecycle changes from retroactively changing an in-flight request's recovery contract.

This decision extends the closed-step recovery, single visible adapter attempt, structured failure, and durable status design in [bounded recovery for transient LLM request failures](../architecture/2026-06-21-bounded-llm-request-recovery.md).
