# Agent Note: Advisory LLM catalogs and per-session ACP model selection

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-15-llm-model-catalog-and-acp-selection.zh.md)

> The catalog and scoped-selection decisions remain current. The temporary removal of ACP selection is superseded by [standard ACP v1 automation controls](../feature/2026-08-22-standard-acp-automation-controls.md), which exposes the catalog through standard session configuration without restoring UI projections.

## Problem

Provider-routed adapters let every request choose `provider + model`, but `LlmRuntime` exposed only routing and streaming. A UI could not discover which providers were registered or which models an adapter was prepared to recommend. ACP clients therefore received no `model` session config option, so Zed, JetBrains, and VS Code integrations had no model list even though the LLM service already supported runtime switching.

Model discovery cannot become request validation. The hand-written DeepSeek adapter deliberately forwards arbitrary model ids to a public or private endpoint, while pi-ai has a finite installed catalog that is authoritative for its own request resolution. Treating one shared catalog as a whitelist would remove the private-endpoint behavior that provider routing was designed to preserve.

ACP selection must also preserve the provider dimension. The same model id may appear under multiple routes, and switching a global adapter or agent template would leak one editor session's choice into every other session. Prompt variables and request routing must change together; a selection that lands during asynchronous prompt assembly cannot make `{{model}}` name one model while the request reaches another.

## Decision

### Provider-neutral advisory discovery

`LlmAdapter` gains `providerInfo(provider)` and asynchronous `listModels(provider)` methods. Their provider-neutral results are `LlmProviderInfo { id, name }` and `LlmModelInfo { provider, id, name, description? }`. The defaults preserve existing adapter behavior by naming a provider after its route and advertising no models.

`LlmRuntime.listProviders()` returns detached metadata in registration order. `LlmRuntime.listModels(provider)` delegates to the route owner, validates non-empty ids and names, rejects a mismatched provider or duplicate model id with `INVALID_CATALOG`, and returns detached values. Unknown providers still fail with `NO_ADAPTER`. Provider metadata is validated atomically during `registerAdapter()` so a malformed display record cannot leave a partial registration.

Catalog membership is advisory. It drives selectors and diagnostics but never changes `stream()` routing and never rejects an otherwise valid request. Provider ownership remains exclusive and lifecycle-bound; model ids remain request-time adapter input.

`dsh-llm-pi-ai` maps the configured provider's installed `getModels(provider)` entries into the neutral catalog. Its existing request-time catalog lookup remains authoritative and still rejects unknown models with `UNKNOWN_MODEL`. `dsh-llm-deepseek` accepts an optional `models` config containing display entries, defaulting to `deepseek-v4-flash` named `DeepSeek-V4-Flash`, `deepseek-v4-pro` named `DeepSeek-V4-Pro`, and image-capable `deepseek-v4-flash-vision-exp` named `DeepSeek-V4-Flash-Vision-Exp`. An explicit list replaces those defaults and an empty list disables discovery. The entries improve selector UX for known public or private models, while every unlisted model id continues to pass through unchanged.

### Per-session selection in the front end

A selection is owned by the front end that offers it, never by `LlmRuntime` or `AgentOptions`: those are deployment-wide or creation-wide objects, and mutating them would couple concurrent sessions. Each opaque choice carries the full provider/model pair, because the same model id may appear under multiple routes.

The ACP automation transport consumes the advisory catalog through standard session configuration options. Its deployment config still supplies the initial provider/model target; each session owns an opaque provider/model choice and a dependent exact-model reasoning-effort choice. Adapter topology changes publish the complete option state. Catalog absence never invalidates the configured route: the current unlisted route is synthesized into the choices.

### Prompt/request consistency and durability

`installModelSelection` (in `dsh-agent`) installs scoped `system-prompt/assemble` and `agent/request` listeners for a front-end-owned selection. Ordinary consumers snapshot the selection once per step. ACP associates its admission snapshot with the identified message in the per-session module until inbox claim, then pins that selection for the complete admitted turn, so asynchronous image admission, prompt variables, and every request step remain aligned without changing the durable user source. A concurrent selection starts on the next ACP turn. Other call-config fields remain untouched.

The request header remains the durable source of truth. When a selection is actually used, the existing full `request/header` snapshot records it, and a front end initializes its selection from the folded last request header before falling back to creation options. A selection that is never used by a request is intentionally in-memory only because it never became model-visible state.

## Alternatives considered

**Return model strings only.** A model-only value loses the provider route and becomes ambiguous as soon as two providers expose the same id.

**Make catalogs mandatory whitelists.** This conflicts with the hand-written adapter's arbitrary model pass-through and private deployments. The selected adapter already owns authoritative request validation.

**Store selection in `AgentOptions` or `LlmRuntime`.** Those are creation-wide or deployment-wide objects. Mutating them would couple concurrent sessions and bypass the logged `agent/request` replacement path.

**Persist a new model-selection session event immediately.** An unused UI selection has not affected a model request. Recording the existing request header when the target is consumed preserves the model-visible-if-and-only-if-logged rule without adding a second source of truth.

## Consequences

- Any adapter can expose a dynamic model list without leaking provider-library types into the LLM Service Definition.
- Catalog consumers must treat absence as “not advertised,” never “invalid request.”
- pi-ai adapters expose their installed provider catalogs; hand-written DeepSeek deployments list known choices explicitly and retain arbitrary model support.
- Each catalog consumer owns its selection interaction. ACP uses standard session configuration options and emits no DSH-specific selector or UI metadata.
- Request headers remain compatible with the provider-routed session shape; no new JSONL event or format version is required.
- A catalog read can be asynchronous, and every caller receives detached values.

## Testing

Unit coverage validates catalog detachment and malformed metadata, pi-ai and DeepSeek catalog projection, provider/model request routing, and prompt-variable alignment; per-agent isolation follows from installing the listeners on the agent-scoped context. ACP tests validate grouped discovery, invalid and concurrent changes, topology updates, header-based restoration, per-turn route pinning, and image-route consistency; human clients test their own selector presentation.
