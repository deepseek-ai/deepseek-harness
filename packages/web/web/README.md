---
description: "The web access service (ctx.web): how deployments and plugin authors search the web and fetch URLs through interchangeable providers, with one selection policy and error vocabulary."
kind: "package-reference"
---

# @deepseek-ai/dsh-web

English | [中文](README.zh.md)

## Summary

Any plugin or tool can search the web or fetch a URL through `dsh-web` (`ctx.web`) without binding to any vendor's API. Search and fetch providers plug in as backends, and the service picks one usable provider per operation, so callers never track which vendor runs behind a call. Choose it when building web tooling or another backend; the shipped model-facing tools (`dsh-tool-web`) mount it automatically. The service itself makes no network calls and registers no model-facing tool: a provider must be mounted before search or fetch can run. Search and fetch share one selection policy, one cancellation and error vocabulary, and one configuration surface, so "how this harness reaches the web" has a single owner.

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

A composition that needs web access loads the `dsh-web` service and mounts at least one backend — a search provider and/or a fetch provider — and plugin or tool authors then call `ctx.web.search()` and `ctx.web.fetch()` directly. The service resolves the backend for each call, so callers never see provider ids unless they configured one.

### When to choose it

Choose the service when a plugin or tool must search or fetch without hard-coding a vendor; a deployment that only uses the shipped `web_search`/`web_fetch` tools gets it for free through `dsh-tool-web`. You do not need it when the composition never reaches the web. The service adds no network access of its own: without at least one usable provider, every call fails with a structured `WebError`.

### Minimal configuration

Load the service and let a single mounted backend auto-select, or pin a provider id with `searchProvider`/`fetchProvider`. The environment variables `$DSH_WEB_SEARCH_PROVIDER` and `$DSH_WEB_FETCH_PROVIDER` feed the same fields and are not a separate priority chain.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-exa'
- name: '@deepseek-ai/dsh-web-fetch-http'
```

| Field | Default | Meaning |
|---|---|---|
| `searchProvider` | (unset) | Pinned search provider id; unset auto-selects when exactly one is usable |
| `fetchProvider` | (unset) | Pinned fetch provider id; unset auto-selects when exactly one is usable |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web) is the exhaustive source for every accepted field and its JSDoc.

### Searching and fetching

`search()` runs one query and returns an optional provider answer plus a list of citeable sources; the service enforces `request.maxResults` by truncating `sources[]` and setting `truncated`. `fetch()` retrieves one URL and returns its final URL, status code, decoded body, and a truncation flag; a non-2xx response is a result, not an error.

```text
// Search the web; sources[] is capped to maxResults:
const result = await ctx.web.search({ query: 'deepseek harness', maxResults: 8 })

// Fetch one URL; a non-2xx response is a result, not an error:
const page = await ctx.web.fetch({ url: 'https://example.com' })
```

Both calls accept an optional `AbortSignal` that is forwarded to the provider for cancellation. The normalized request and result shapes are the contract callers build on; the vocabulary section of the [web subsystem](../../../docs/subsystems/web.md) reference describes them exhaustively.

### Provider selection

Each call resolves its provider at execution time, and registration or load order never matters. A configured provider id wins when it is registered and usable; without a configured id, the service runs the single usable provider or fails clearly:

| Situation | Outcome |
|---|---|
| configured id registered and usable | runs that provider |
| configured id not registered | `WEB_PROVIDER_CONFIGURED_MISSING` |
| configured id registered but unavailable | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| no id, exactly one registered usable provider | runs it |
| no id, no usable provider | `WEB_PROVIDER_UNAVAILABLE` |
| no id, multiple usable providers | `WEB_PROVIDER_AMBIGUOUS` |

A provider's availability is a cheap local check — for example whether its API key is present — and never makes network calls, so selection stays fast and deterministic.

### Failures and recovery

Failures throw `WebError` with a stable, machine-routable code; the message adds detail such as the missing provider id or the ambiguous candidate set. Callers route on the code and decide how to degrade. To change which backend a call uses, reconfigure the pinned id, mount or unmount providers, or fix the provider's configuration so its availability check passes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is built on one deliberate separation:

- **One seam, two independent operations.** Search and fetch share no request schema and no business logic, but they share one service so provider selection, cancellation, errors, and product configuration have a single owner. The parallel `Search`/`Fetch` method pairs are intentional.
- **Selection is never order-dependent.** A capability either pins a provider id or auto-selects when exactly one usable provider is registered; `search()`/`fetch()` resolve the provider at execution time.
- **The service owns the result bound.** `maxResults` is enforced by the seam after the provider returns, so an over-returning provider can never leak more sources than the caller asked for.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `WebRuntime` service, both provider registries, and execution-time selection |
| [`src/types.ts`](src/types.ts) | Vocabulary: request/result types, the closed `WebFetchBody` union, and the `WebError` taxonomy |
| — | No runtime invariant companion is published; provider maps are private and selection/result caps are enforced on each call; the seam publishes no independent registry or request/result observation stream. |

### Data model

The request and result types define the normalized vocabulary callers build on — one `Search` pair and one `Fetch` pair — and the exhaustive fields and JSDoc live in [`src/types.ts`](src/types.ts) and the [web subsystem](../../../docs/subsystems/web.md) reference. Two deliberate choices shape them: `WebFetchBody` is a closed union (`html` | `text`) owned here, so adding a kind breaks compilation until every consumer handles it; `WebError` extends `HarnessError` with an open-string `code`, so consumers must tolerate provider-specific values. Source fields stay optional because not every provider returns all of them.

### Selection flow

At call time the service resolves the provider — configured id first, then the unique usable provider — and throws the matching `WebError` when no clear winner exists. A search result then passes through `capSources`, which truncates `sources[]` to `maxResults` and flags `truncated`. Registration is effect-based: providers register with the calling fiber and unregister when it disposes, and a duplicate id within a capability kind is rejected at registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the shipped backends, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search/fetch requests and results, provider availability, and error codes.
- [Web package map](../README.md) — the six-package family and each role.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` and `web_fetch` tools over this service.
- [dsh-web-fetch-http](../web-fetch-http/README.md) — the shipped anonymous HTTP(S) fetch backend.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which renders the seam's normalized search results and fetch bodies to the model while this service contributes no prompt or schema.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the service is incomplete on its own. They are current package constraints.

- **No observation surface** — there is no provider-change event and no capability-status query; availability is observable only by running a search or fetch and routing the thrown code, and the no-provider failure is the generic `WEB_PROVIDER_UNAVAILABLE` with no per-provider reason enumeration ([Agent Note](../../../.agents/notes/archived/simplification/2026-07-04-drop-unconsumed-web-observation-surface.md)).
- **Search requests carry only `query` and `maxResults`** — provider-neutral controls (recency, domain filters, regional hints, search depth) are deferred until the backends can honor them ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **`WebFetchBody` has no `pdf` arm** — text-extractable PDF support is named deferred work; the closed union makes adding it a compile-enforced change across the web packages.
- **Provider-backed page extraction is out of scope of `fetch()`** — a Firecrawl/Tavily-style `web_extract` capability is deferred rather than widening the fetch operation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: observing provider state

No provider-change event or capability-status query exists; consumers observe availability only by executing a call and routing the thrown code. Restoring a small observation surface is possible if a consumer needs per-provider reasons, but the archived simplification note records why the earlier one was dropped.

</details>
