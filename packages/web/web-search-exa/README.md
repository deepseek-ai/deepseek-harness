---
description: "The Exa-backed search provider for ctx.web: how deployments mount vendor-native web search with portable snippets and publication dates."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-exa

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-exa`, the harness searches the web through Exa and gets vendor-native results with portable snippets and publication dates. Choose it when a deployment has an Exa API key and wants Exa's keyword or neural search. Exa returns no generated answer, so results carry no `content` — only citeable sources. A result with no non-blank highlight is dropped, so a call can return fewer sources than requested. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `exa` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: exa`.

### When to choose it

Choose this backend when a deployment holds an Exa API key and wants Exa's keyword or neural search with per-result highlight snippets and publication dates. The provider is unavailable — and every search call fails with a structured error — when the key is empty or the endpoint base does not parse.

### Minimal configuration

Load the web service and the provider; the API key falls back to `$EXA_API_KEY` from the launch environment, and all other settings have safe defaults.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKey: !!js process.env.EXA_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | Exa API key; empty or absent makes the provider unavailable |
| `baseURL` | `https://api.exa.ai` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable |
| `searchType` | `auto` | Retrieval mode sent as Exa's `type`: `auto`, `keyword`, or `neural` |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`; must be a positive integer |
| `highlightsPerResult` | `1` | Highlight sentences requested per result (Exa's `highlightsPerUrl`); must be a positive integer |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-exa) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each Exa result maps to a `WebSearchSource`: `url`, `title`, the first non-blank highlight as `snippet`, and `publishedDate` as `publishedAt`; a result with no highlight has no portable snippet and is dropped. A request's `maxResults` wins over the configured `numResults` default and is sent to Exa as a cost and latency optimization — the final bound is enforced by the service, which truncates and flags. Exa returns no generated answer, so the result carries no `content`.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Exa's API with two deliberate rules:

- **Portable snippets only.** A source gains a `snippet` only from a real highlight; inventing one from other fields would make the seam lie, so snippet-less results are dropped entirely.
- **No invented answers.** Exa returns no generated answer, so `content` is omitted rather than fabricating provider prose the model might trust.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `ExaSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Exa wire types: `ExaSearchResponse`, `ExaResult`, `ExaError` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` posts the query, retrieval mode, highlight request, and optional result count to `{baseURL}/search` with `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `results[]` are mapped one by one, snippet-less entries dropped, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the six-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-exa) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, first highlights, and publication dates or its exact `Exa search aborted`, `Exa search request failed: <error>`, and `Exa returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **A result with no non-blank highlight is dropped entirely** — there is no portable snippet to map, so fewer sources than requested can return.
- **Only `searchType`/`numResults`/`highlightsPerResult` are exposed** — Exa's other controls (livecrawl, category, domain/date filters, full-text contents) wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Exa control surface

Exa's livecrawl, category, domain and date filters, and full-text contents stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
