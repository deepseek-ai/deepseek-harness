# Agent Note: Routed model context and compaction policy

Status: implemented

English | [中文](2026-07-20-routed-model-context-and-compaction-policy.zh.md)

## Problem

Compaction cannot safely apply one global context window when a process routes requests to models with different capacities. The same model id can also exist under multiple providers, and an adapter may accept dynamic ids absent from its advisory catalog. A wrong capacity either compacts too late and triggers avoidable overflow or compacts too early and discards useful context.

Neither obvious configuration owner is sufficient. Compact-basic is optional and does not know which models an adapter accepts. LLM adapters own model routing but must not depend on an optional compaction plugin or absorb consumer-specific threshold, retention, summarizer, and retry policy. The design needs an authoritative capacity fact and optional per-target compaction policy without creating a second model registry.

## Decision

### Adapters own exact-route capacity

`LlmAdapter.resolveModel(provider, model, signal?)` returns aggregate metadata for one exact route, with optional `LlmModelContext` under its `context` field. `LlmRuntime.resolveModelInfo()` selects the registered route owner, validates a positive integer `contextWindow`, and returns detached metadata. The query is independent of `listModels()`: an unlisted dynamic model may have capacity metadata, and an absent `context` means only that the adapter cannot describe capacity.

The hand-rolled DeepSeek adapter accepts optional `contextWindow` on each configured model plus an adapter-wide `defaultContextWindow`. Exact model capacity wins; an entry without capacity and an unlisted pass-through id inherit the adapter default, or omit `context` when it is absent. The two built-in model entries each publish an exact 256,000-token capacity. The pi-ai adapter resolves capacity from the same catalog descriptor that authoritatively resolves the request model.

### Token measurement remains model-agnostic

`dsh-token-meter` has no configuration and no model profiles. It owns one fixed replay fold and returns absolute estimated token pressure plus positional surface prices. Removing global capacity keeps measurement reusable when compaction-basic is absent and prevents replay accounting from becoming another model registry.

### Compact-basic resolves a target spec

Compact-basic owns consumer policy. Top-level fields define defaults; `modelPolicies` contains partial overrides keyed by the exact `{ provider, model }` pair. Duplicate targets and unknown or invalid fields fail plugin load. `thresholdRatio` defaults to `0.8`, and retention defaults to `retainRatio: 0.16`; callers may use an absolute `retainTokens` instead, but the two retention forms are mutually exclusive. After inheritance, a ratio retention that is not below its threshold ratio also fails plugin load because no model capacity can make that policy valid.

For proactive pressure, compaction-basic reads the latest durable request route, resolves its adapter capacity and exact-target policy, and scales ratios into a `ResolvedCompactSpec`. It performs this resolution on every check, so a provider or model switch in one session changes capacity and policy immediately. An absolute retained budget that is not below the scaled threshold fails when the target capacity first makes that comparison possible.

The same exact-target override can select summarization provider/model, summarization output cap, convergence retries, and overflow retry cap. These are compaction concerns and never enter an LLM provider.

### Target-specific pressure failures preserve optional composition

An adapter that lacks capacity metadata remains a valid LLM route. Manual proactive pressure fails with a target-specific configuration error; the automatic listener warns once per exact route and continues with full history. The same per-route suppression applies when resolved capacity exposes an invalid absolute retention budget, while unrelated operational failures remain independently visible. Canonical provider-confirmed overflow does not need capacity metadata: it bypasses the proactive threshold and normal retention budget, attempts one maximal balanced reduction, and preserves the original provider error unless replacement proves progress.

## Testing

Service tests cover detached context metadata, invalid adapter output, catalog independence, and default absence. Adapter tests cover DeepSeek exact/default/unlisted resolution, invalid capacities, and pi-ai exact descriptor resolution. Compact tests cover ratio scaling, exact provider/model overrides, load-time rejection of invalid merged ratios, runtime absolute-budget validation, same-model-id provider switches, target-specific warning suppression, and capacity-independent overflow recovery. Loader fixtures reject the removed token-meter capacity setting, and examples configure capacity on adapters.

## Alternatives considered

- **Put capacity and all policies in compaction-basic** — rejected because compaction-basic would duplicate adapter model knowledge, dynamic unlisted models would require parallel registration, and capacity would disappear when compaction is not installed.
- **Put compaction policy in each LLM adapter** — rejected because adapters must remain independent of optional consumers, while summarization and retry policy are not provider facts.
- **Make `listModels()` authoritative** — rejected because discovery is advisory and some adapters intentionally accept dynamic ids. Correctness metadata must not turn selector membership into a routing whitelist.
- **Add per-model folds to token-meter** — rejected because the replay algorithm is shared; only the capacity and consumer policy change. Multiple folds would duplicate state without improving estimation.
- **Create a standalone model-context registry** — rejected because the adapter already owns authoritative route resolution. A second registry would introduce lifecycle ordering, duplicate-key, and drift problems without an independent backend.

## Consequences

- Capacity has one authoritative owner at the provider contract, while compaction policy stays in the optional consuming plugin.
- The same compaction-basic instance safely handles different windows, provider switches, and identical model ids under different providers without consulting discovery metadata.
- LLM-only and meter-only compositions remain valid; loading compaction-basic adds no reverse dependency from adapters.
- DeepSeek deployments may set exact per-model capacities, or use `defaultContextWindow` for entries without capacity and unlisted pass-through ids.
- Ratio defaults scale naturally across models, while exact-target absolute retention remains available for deployment-specific behavior.

This note supersedes the global-capacity and no-model-policy parts of the [replay token meter service Agent Note](../../archived/architecture/2026-07-15-replay-token-meter-service.md). Its single-fold measurement decision remains unchanged.
