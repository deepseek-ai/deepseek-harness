---
description: "The Perplexity-backed search provider for ctx.web: how deployments mount OpenAI-compatible Perplexity search with generated answers and citations."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-perplexity

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-perplexity`, the harness searches the web through Perplexity and gets a model-generated answer plus citeable sources in one call. Choose it when a deployment has a Perplexity API key and wants a generated answer. Perplexity has no result-count control, so the returned sources are truncated to the requested bound after the fact. When Perplexity omits structured result metadata, sources fall back to URL-only citations. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `perplexity` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: perplexity`.

### When to choose it

Choose this backend when a deployment holds a Perplexity API key and wants a model-generated answer plus citeable sources in one search. The provider is unavailable — and every search call fails with a structured error — when the key is empty or the endpoint base does not parse.

### Minimal configuration

Load the web service and the provider; the API key falls back to `$PERPLEXITY_API_KEY` from the launch environment, and all other settings have safe defaults.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-perplexity'
  config:
    apiKey: !!js process.env.PERPLEXITY_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `$PERPLEXITY_API_KEY` | Perplexity API key; empty or absent makes the provider unavailable |
| `baseURL` | `https://api.perplexity.ai` | Endpoint base; `/chat/completions` is appended. An unparseable value makes the provider unavailable |
| `model` | `sonar` | Search model name |
| `maxTokens` | `1024` | Upper bound on generated answer tokens (`max_tokens`); must be a positive integer |
| `searchRecency` | (unset) | Recency window sent as `search_recency_filter`: `day`, `week`, `month`, or `year`. Unset sends no filter |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-perplexity) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

`content` carries Perplexity's generated answer. `sources[]` prefers the structured `search_results[]` (`url`, `title`, `snippet`, `publishedAt` from `date`) and falls back to the URL-only `citations[]` array only when `search_results` is absent — which is why `title`/`snippet`/`publishedAt` are optional on the service. Perplexity exposes no result-count control, so the service enforces `maxResults` by truncating and flagging.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Perplexity's chat-completions endpoint with two deliberate rules:

- **The generated answer is trusted as `content`.** Unlike the other search backends, Perplexity returns a model-generated answer, and this provider passes it through as the normalized `content` field.
- **Structured sources win; URL-only citations are the fallback.** `search_results[]` carries the portable fields; `citations[]` carries only URLs, and the service vocabulary makes those fields optional precisely for this case.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `PerplexitySearchProvider`: request dispatch, abort classification, answer and source mapping |
| [`src/types.ts`](src/types.ts) | Perplexity wire types for the chat-completions response |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` posts the query with the model, token cap, and optional recency filter to `{baseURL}/chat/completions` with `redirect: 'error'`. The response's `content` becomes `content`; `search_results[]` becomes `sources[]` when present, otherwise each `citations[]` entry becomes a URL-only source; and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the six-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-perplexity) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary Perplexity request

#### What the model sees

A separate Perplexity model receives `<query>` verbatim as its sole user message through the chat-completions endpoint. This request is not part of the conversation model's context.

#### Token effect

Separate provider tokens are incurred per search; `maxTokens` caps the generated answer.

#### KV Cache effect

Independent of the conversation request cache. An identical query under the same model route may reuse provider cache; a changed query or route establishes a different prefix.

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees the generated answer plus structured result metadata or URL-only citations. This provider's exact failures are `Perplexity search aborted`, `Perplexity search request failed: <error>`, and `Perplexity returned an unprocessable response body: <error>`; HTTP failures preserve the provider message. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Answer and source tokens are data-dependent, source count is service-bounded, and the retained result or error is resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Citation-fallback sources are URL-only** — when Perplexity omits structured `search_results[]`, sources carry no `title`/`snippet`/`publishedAt`, so the tool renders bare hostname labels.
- **Over-returned sources still cost tokens and latency** — with no result-count control on the wire, `maxResults` is enforced only post-hoc by service truncation.
- **Only `model`/`maxTokens`/`searchRecency` are exposed** — Perplexity's other search controls (domain filters, `web_search_options` context size, images) wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Perplexity control surface

Perplexity's domain filters, `web_search_options` context size, and image support stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
