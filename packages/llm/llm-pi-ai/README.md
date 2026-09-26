---
description: "The pi-ai-backed multi-provider adapter for users and maintainers routing the harness LLM service through pi-ai catalogs and hand-declared gateways."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-pi-ai

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-pi-ai` routes model requests to multiple pi-ai providers, OpenAI-compatible gateways, or self-hosted servers from one configuration. Installed pi-ai providers supply endpoint, protocol, and model-catalog defaults; custom routes can declare those values without code changes. Profiles and credentials are resolved for each request, so settings changes take effect on the next request without a restart. Supported providers can use stored OAuth or interactive-key sign-in with cross-process refresh locking. The package may start with no routes and activate when user settings add them.

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

Mount this plugin when a composition routes model requests through pi-ai's provider catalogs or through gateways that pi-ai's installed catalog does not describe. The `providers` dictionary is the whole configuration surface: each key is the provider route name a request selects with `GenerateOptions.provider`.

The adapter accepts the LLM service's [request-only user inputs](../llm/README.md#use-this-package) alongside durable history. User identity and attribution do not enter pi-ai content; assistant replay metadata and tool-call correlation remain attached to durable messages.

### When to choose it

Choose this adapter when the same composition serves several providers, when a route needs pi-ai's catalog defaults with a few fields corrected, or when a hand-declared gateway must be reached through its own endpoint and protocol. Choose `dsh-llm-deepseek` for the direct DeepSeek route when the deployment needs no other provider. Both adapters can be mounted together because their route names do not collide; registering a route another adapter already owns fails plugin loading.

### Configure provider routes

Each profile may set a `retryPolicy`; omission uses normal mode with five retries. `apiKeyEnv` is a credential reference resolved per request through the harness credential seam, so no secret enters the configuration file; a reference that resolves to nothing fails the request with `MISSING_CREDENTIAL`. Omitting it leaves the route configured-but-keyless, which for an installed catalog route defers to pi-ai's provider-native ambient discovery.

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        requestImagePixelBudget: 4194304 # total pixels; 2048 by 2048 default
        requestImageMaxBytes: 1048576    # raw bytes before base64 expansion
        maxRequestImageBytes: 20971520   # accumulated base64 payload
        retryPolicy:
          mode: normal
          maxRetries: 3
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        models:
          - id: claude-sonnet-4-5
            contextWindow: 200000
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example/v1
        compat:
          thinkingFormat: deepseek
        models:
          - id: acme-think
            name: Acme Think
            contextWindow: 262144
            reasoningEfforts:
              off:
              high: high
```

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | absent | Credential reference resolved per request; omission defers to pi-ai ambient discovery |
| `displayName` | provider name | Label shown by selector surfaces |
| `api` | catalog protocol | Wire protocol; only needed for routes the catalog does not supply |
| `baseURL` | catalog endpoint | Endpoint of every model on the route |
| `models` | installed catalog | Replaces the route's catalog wholesale; each entry defaults from the installed model |
| `modelOverrides` | none | Reshapes individual installed-catalog models without replacing the rest |
| `compat` | catalog detection | Wire-compatibility switches for unrecognized endpoints |
| `defaultContextWindow` | `262,144` | Capacity fallback for undescribed models |
| `defaultMaxTokens` | `32,768` | Output-cap fallback for undescribed models |
| `requestImagePixelBudget` | `4,194,304` | Total-pixel budget for each deterministic request image |
| `requestImageMaxBytes` | `1 MiB` | Encoded-byte target for each request image before base64 expansion |
| `maxRequestImageBytes` | `20 MiB` | Aggregate base64 image-payload bound; a request whose retained images exceed it fails with `IMAGE_OFFLOAD_REQUIRED` |
| `retryPolicy` | normal, 5 retries | Provider-owned retry policy executed by `dsh-llm-retry` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-pi-ai) is the exhaustive source for every accepted field and its JSDoc.

### Sign in to a provider

A provider pi-ai ships a login for can be signed into through the harness authorization seam: the flow offers OAuth or an interactive key prompt (a key is typed into pi-ai's own login prompt, not into the settings form), and the resulting credential is stored in the harness credential store at `llm-pi-ai/<provider id>`. The stored sign-in authenticates its route beneath any `apiKeyEnv` override and refreshes itself under the store's cross-process lock; signing out deletes the stored record. A hand-declared route key outside the record grammar — a lowercase hyphenated identifier — cannot be signed into, because a record write for it refuses with `LlmError('UNSTORABLE_PROVIDER_ID')`; such a route authenticates through `apiKeyEnv` or ambient provider settings instead.

### Resolve the model catalog

A profile's `models` list replaces the route's installed catalog rather than extending it; each entry defaults its unset fields from the installed model of the same id, so narrowing a route to two models, correcting one capacity, or adding a model newer than the installed catalog are one-line edits. `modelOverrides` reshapes individual installed-catalog models without that cost — correct one model, keep the other thirty-seven — and is refused when set beside a `models` list, on a hand-declared route, or naming a model the catalog does not describe, because a silently unchanged model would be a typo someone hunts for later.

### Run with reasoning and wire compatibility

`reasoningEfforts` declares a model's selectable thinking levels: each key is a level selectors offer, its value the spelling dispatch sends on the wire, so `max: ultra` renames a level for a gateway with its own vocabulary. Omitting the field keeps the installed catalog entry's capability; `false` declares a non-reasoning model. `compat` switches reshape the request for endpoints pi-ai cannot recognize — which role carries the system prompt, which field caps output, how a thinking level travels — configurable per route and per model. A model neither the entry nor the installed catalog sizes takes the route's `defaultContextWindow` and `defaultMaxTokens` fallbacks.

For self-hosted Chat Completions endpoints, `thinkingTokenBudgetField` selects the reasoning-budget parameter, and `vllmPriority` sets an integer scheduler priority when the server enables priority scheduling. Template arguments accept `$var: thinking.budget`. `openai-responses` gateways can set `supportsMaxOutputTokens: false` to omit `max_output_tokens`; Azure and Codex transports ignore this shared compatibility field. These controls are opt-in; catalog-owned Anthropic effort and fallback capabilities are not configurable switches.

### Change configuration at runtime

Each operation captures the current `providers` Config reference. New or changed provider profiles are validated before form persistence; unchanged catalog failures remain editable. Route-set or retry-policy changes update registration atomically, preserving previous routes if another adapter owns a requested route.

### Discover models from endpoints

The plugin answers "which models can this provider serve?" for a route a configuration surface is editing or drafting. A route the installed catalog ships is answered from that catalog with no network call, preserving its `input` array as discovery `inputModalities`; only a route the catalog does not describe is interrogated over the wire. `openai-completions` and `openai-responses` use `GET {baseURL}/models` with bearer auth, while `anthropic-messages` uses native `GET /v1/models?limit=1000` semantics with `x-api-key` and `anthropic-version`; its listing URL accepts the API root with or without a trailing `/v1` because gateway documentation publishes both spellings, and only that listing URL normalizes the segment, so model requests receive the configured `baseURL` unchanged. A named configured route supplies its stored credential and profile `headers` inside the Host, so deployment headers configured through `cordis.patch.yml` or Cordis config reach model discovery without becoming discovery-request or Models-page fields; a key typed into the form still wins over the stored credential. The parser accepts either the standard `data` array or an enriched `models` map, normalizing each candidate's id, display name, context window, and output-token cap; Anthropic's `max_input_tokens` and `max_tokens` feed the same capacity fields, a map key remains the request id even when its entry names a different canonical id, primitive-valued map properties are ignored, and a missing display name falls back to that request id. The reply is candidate metadata a surface may offer for adoption — nothing is stored, and `cordis.patch.yml` remains the only thing that decides what a route serves.

### Failures and recovery

A route pi-ai does not ship needs `api`, `baseURL`, and a non-empty `models` list; an unserviceable profile is refused where it is written, naming the route and model. Failures carry stable codes: a credential that cannot be used fails with `INVALID_CREDENTIAL` naming the route and reference, a route whose `apiKeyEnv` reference resolves to nothing fails with `MISSING_CREDENTIAL`, an unconfigured model fails with `UNKNOWN_MODEL`, and terminal provider failures distinguish `QUOTA` from transient `RATE_LIMIT`. `GenerateOptions.stop` is rejected with `UNSUPPORTED_OPTION` because pi-ai's common streaming UI cannot guarantee it across providers.

Config updates strictly validate changed providers. Initial loading retains stored catalog failures as editable provider diagnostics; unchanged failed providers do not block edits elsewhere. Serviceable models remain selectable, and unresolved models fail before network I/O. Repairing or deleting the offending configuration clears its diagnostic.

Changing `displayName`, `apiKeyEnv`, or `baseURL` without resolving the provider's model errors still rejects the save. For example, renaming an OpenRouter route whose model `111` needs an `api` cannot be saved on its own: repair or remove that model in the same editor draft, then save the complete provider configuration. Intermediate repairs remain in the draft until the whole provider validates; other providers can be saved independently.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the adapter; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on immutable snapshots and per-operation resolution. Each operation captures a whole snapshot — the profiles plus a `createModels()` collection holding the `Provider` each route built — before its first `await`, and a configuration change builds a new collection rather than mutating the one in use, so a request that started under one configuration never finishes under another. A route's own credential reference resolves through the harness seam and rides as the request's `apiKey` option, which pi-ai treats as the highest-priority auth override — that is what keeps the fail-loud reference semantics. Everything that override does not cover reaches pi-ai through the collection's own auth: the credential store holds the records a login wrote and a refresh rotates (addressed as `llm-pi-ai/<provider id>`), and the auth context answers the ambient questions a provider asks while resolving. Both are stable across snapshots, so a configuration change rebuilds the collection without forgetting who is signed in. Runtime imports use pi-ai's provider, API, and utility entry points; `src/models.ts` supplies the small model-helper subset this adapter needs without evaluating pi-ai's aggregate entry point.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config snapshots, directory and route registration |
| [`src/auth.ts`](src/auth.ts) | The credential store and ambient auth context over the harness credential plane |
| [`src/login.ts`](src/login.ts) | Authorization flows for the installed providers that ship a login |
| [`src/config.ts`](src/config.ts) | Profile schema, resolution, and serviceability checks |
| [`src/catalog.ts`](src/catalog.ts) | Installed-catalog integration and drift gates |
| [`src/models.ts`](src/models.ts) | Model collections, static providers, and reasoning levels over narrow pi-ai entry points |
| [`src/provider.ts`](src/provider.ts) | The supported-protocol table and provider construction |
| [`src/context.ts`](src/context.ts) | Harness-to-pi-ai context conversion, image handling, replay restore |
| [`src/stream.ts`](src/stream.ts) | pi-ai event conversion into harness `StreamChunk` values |
| [`src/replay.ts`](src/replay.ts) | Versioned `ReplayEnvelope` storage and validation |
| [`src/discovery.ts`](src/discovery.ts) | Endpoint interrogation for configuration surfaces |

### Registration and directory

The plugin declares every installed catalog provider it can authenticate in the configurable-provider directory, joined with every route the current profiles declare, so configuration surfaces can offer the full catalog before any route exists. Each entry carries `declared` — whether pi-ai ships nothing under that key — because only the adapter can distinguish a hand-declared route from a narrowed catalog route. Route registration is atomic: a candidate set that collides with another adapter leaves the previous routes serving. A bare mount with zero routes is the dormant posture: nothing registers until the Config supplies profiles, and routes drop when it empties.

### Replay and vocabulary

Successful assistant responses store a versioned, lossless-JSON replay state beside the provider and model that produced them — response-level facts plus one per-block entry per streamed block. At request time, `LlmRuntime` passes replay state only when the same adapter instance owns both routes; the adapter validates it and restores native response ids, provider signatures, and optional `providerThinkingLevel` effort metadata, keeping absent effort metadata absent. Replay validates the requested model identity against the assistant source and separately restores an Anthropic response model when the provider resolved an alias or fallback. Absent or unusable replay state degrades to provider-neutral content while preserving the assistant source’s required provider and model. pi-ai tool-call arguments are parsed objects, so the adapter parses input and re-stringifies output to the harness raw-JSON convention; pi-ai in-stream error events map to terminal `finish` chunks.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the service contract to the twin adapter and the shared types.

- [dsh-llm service](../llm/README.md) — the provider-neutral service this adapter registers on.
- [llm-deepseek adapter](../llm-deepseek/README.md) — the direct DeepSeek twin for the `deepseek-official` route.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract.
- [llm-retry](../llm-retry/README.md) — the retry executor that applies each profile's `retryPolicy`.
- [Twin LLM adapters](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) — why the DeepSeek route ships two structurally different adapters.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-pi-ai) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Provider request through pi-ai

#### What the model sees

The selected catalog model receives one system prompt (`GenerateOptions.system`, otherwise the text of a leading `system` history message; a leading system message with empty text sends none), the remaining history, tools, and sampling fields supported by pi-ai's common streaming API. Each retained image is preceded by text naming its complete attachment id and actual request dimensions. When the current execution filesystem maps the attachment provider's host object, the text also carries a read-only normalized-object path and warns that normalization or request projection may have resized or re-encoded the upload. Each occurrence selected by a logged image-offload decision keeps its own identity and currently resolved access in replacement text, and its normalized attachment is not read or transformed. When the retained occurrences' exact base64 payload still exceeds the route's `maxRequestImageBytes`, the call fails with `IMAGE_OFFLOAD_REQUIRED` so `dsh-compaction-image-offload` records the selected occurrences in an `image/offload` event and retries the step. Provider-native replay metadata is restored only when the adapter validates it for the historical content.

#### Token effect

Provider tokenization governs exact input. Retained images add the stable attachment and coordinate descriptor; the offload placeholder replaces an omitted image's visual tokens. Replay metadata may let a native API reuse provider-side state.

#### KV Cache effect

Conversion preserves logical request order, while image handles and offload placeholders add model-visible text. A changed execution-world path rewrites a historical handle and can prevent reuse from that image even when attachment identity and request bytes stay stable. Changing adapter instance, provider, model, or another upstream token has the same suffix effect. An offload decision turns an earlier image into placeholder text, so reuse ends at that message; the omission never reverts, so the prefix stays stable afterwards.

### Provider response

#### What the model sees

pi-ai events become harness reasoning, text, tool-call, usage, and finish chunks. The adapter passes parsed tool arguments to the harness as raw JSON strings.

#### Token effect

Generated content affects later inputs only after the loop records it. pi-ai folds reasoning tokens into output usage when the provider does not report them separately, and preserves its exact `totalTokens` value unchanged.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix. Unrecorded transport metadata and usage accounting do not affect cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the adapter stops and future work begins. They are current package constraints, not a general pi-ai comparison or a task backlog.

- **`maxRequestImageBytes` counts base64 image payload only** — text, tools, descriptors, and JSON structure ride outside the bound, so it must sit below the gateway's request-body cap with headroom.
- **A sign-in lives only in the process that started it** — an authorization attempt is not durable, so reloading the page mid-login abandons it and the human starts over. Signing out is `deleteRecord` on the stored record, which forgets it locally without telling the issuer.
- **Provider-native discovery answers through this plugin's ambient context** — a route naming no credential defers to the catalog provider's own resolution, which asks for environment values (`AZURE_OPENAI_API_KEY`, `AWS_PROFILE`, and each provider's own set) and for local credential files. Both questions are answered here: the credential seam is consulted before the process environment, and file existence is checked against the host process's filesystem with `~` expanded. What it cannot do is *read* a credential file's contents — a provider that parses `~/.aws/credentials` itself does so directly, outside the seam.
- **Reset restores inherited configuration** — resetting a route supplied by a lower profile layer restores that route.
- **Complete Config replacement can remove inherited dictionary entries** — a field reset instead restores its inherited value.
- **`headers` can carry a credential the redactor never sees** — profile resolution rejects names and values Fetch cannot represent, but the dict remains plain strings; store credentials as `apiKeyEnv` references.
- **Discovery does not change configured models** — adopt discovery results explicitly into the route configuration.
- **Anthropic discovery reads at most 1,000 models** — the request uses the API's maximum page size but does not traverse `has_more`; entries beyond the first page must be added by hand.
- **One wire protocol per route** — a mixed-protocol catalog route cannot host a model of the other protocol; splitting the provider across two route keys is the workaround.
- **A modality declaration is not verified** — a model declaring `image` its gateway does not serve is refused by the provider after prompt admission. The durable image remains in history and the same misdeclared model can fail again; switching to a text-only model remains possible because the shared LLM runtime projects image references into stable text for that request.
- **An unauthenticated route depends on its protocol** — a route naming no credential resolves as configured-but-keyless, but pi-ai's OpenAI-compatible implementation still requires an API key or an `Authorization` header, so a keyless local server needs a placeholder credential referenced by `apiKeyEnv` or an `Authorization` entry in `headers`.
- **`GenerateOptions.stop` is unsupported** — pi-ai's common stream options cannot guarantee stop-sequence behavior across providers.
- **Only a leading in-history `system` message becomes pi-ai's `systemPrompt`** — pi-ai has one system slot, so a later `system` message, or a leading one when `GenerateOptions.system` is also set, folds into a `user` message at its position; provider-specific placement of the prompt follows pi-ai rather than a harness-owned wire override. Images in system or assistant history, including the leading system message, fail with `UNSUPPORTED_CONTENT` on both conversion paths.
- **Provider HTTP status is unavailable** — pi-ai error events do not expose a stable HTTP status across providers.
- **Retry policy is provider-owned, not an SDK retry** — pi-ai SDK retries stay disabled so durable agent steps and `llm/retry` events own every visible attempt, and direct `ctx.llm.stream()` calls remain single-attempt.
- **Streamed tool-call arguments are parsed once, when the call ends** — the installed pi-ai carries [`patches/@earendil-works__pi-ai@0.85.1.patch`](../../../patches/@earendil-works__pi-ai@0.85.1.patch), which removes the per-delta re-parse of the whole accumulated argument JSON in every stream adapter (upstream [earendil-works/pi#9265](https://github.com/earendil-works/pi/issues/9265)); unpatched, a multi-megabyte argument stream costs O(n²) CPU on the event loop and stalls every session in the process. Until `toolcall_end`, a pi-ai partial's tool-call `arguments` stays `{}`; this adapter reads only the delta strings and the finalized arguments. Re-apply or retire the patch on every pi-ai upgrade.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The offered protocol set is deliberately narrower than pi-ai's full API set: Bedrock, Vertex, Azure, and Codex authenticate through flows a profile cannot completely describe with a key, an endpoint, and headers; catalog routes still reach them through their own provider, and only an explicit override is refused. Codex is sign-in-able through the authorization flow's OAuth grant.
- The `compat` switch set is pinned to pi-ai's compat types by drift gates; an upstream upgrade that adds a field, gives a further protocol a compat type, or widens a value union fails the build until someone classifies it.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
