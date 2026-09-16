---
description: "Configure DeepSeek Messages, Chat Completions overrides, reasoning, and image input through one first-party provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek

English | [中文](README.zh.md)

## Summary

Stream DeepSeek models through `deepseek-official` with Messages by default, or select Chat Completions in Cordis YAML. Both protocols share credentials, endpoint settings, image handling, and the model catalog. Valid settings changes affect subsequent calls while in-flight calls retain their configuration. Web shows one DeepSeek provider with an editable API base and key. This package can run beside the [pi-ai adapter](../llm-pi-ai/README.md).

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

Mount this plugin when a composition streams DeepSeek models through the harness LLM service. It registers the single `deepseek-official` route and resolves connection facts per request, so a composition entry plus an optional user settings section drive the whole adapter.

### When to choose it

Choose this adapter for DeepSeek's official API or a gateway that supports the selected protocol through `baseURL`. Choose `dsh-llm-pi-ai` when the same composition also routes other providers or hand-declared gateways through pi-ai's catalogs; the two adapters can be mounted together because their route names do not collide. Registering any other adapter for `deepseek-official` fails with `DUPLICATE_ADAPTER`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY  # credential reference, resolved per request
    reasoningEffort: high        # optional; off | low | high | max
    maxTokens: 256000            # optional per-request output cap
    maxRequestFilesBytes: 134217728
    maxInlineRequestImageBytes: 20971520
    maxImagesPerRequest: 600
    filesApiTimeoutMs: 60000
```

A request selects the route with `provider: deepseek-official`; the model id passes through to the wire, so new DeepSeek models need no re-registration. Omitted `models` advertises the text- and image-capable `deepseek-flash` and `deepseek-v4-flash-vision-exp` alongside the text-only `deepseek-v4-flash` and `deepseek-v4-pro`, each with a 1,000,000-token context window. An explicit list replaces those defaults, and unlisted model ids still pass through as text-only routes. Clients, including model discovery tools, can read the advisory entries through `ctx.llm.listModels('deepseek-official')`. Image-capable entries may set `imagePixelBudget` to a positive integer or `low`, and may set `imageMaxBytes`. An entry may declare `systemPromptUpdate: in-history` when its endpoint reads the latest `system` message at any position of `messages` as the complete effective system prompt; the adapter reports the mode on the resolved model and the prepared call, and the agent loop then appends a changed prompt after the cached history instead of rewriting the leading system message ([decision rule](../../core/agent-loop/README.md#understand-the-implementation)). The default `deepseek-flash` entry declares this mode; other models require an explicit `models` declaration, and any value other than `in-history` fails at load with `llm-deepseek: catalog model "<id>" systemPromptUpdate must be "in-history" when present`.

| Field | Default | Meaning |
|---|---|---|
| `protocol` | `messages` | Choose `messages` or `chat-completions` in Cordis YAML; Web has no protocol selector |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved per request through the credentials seam, then the environment |
| `baseURL` | Selected protocol’s official root | Explicit value, then `$DEEPSEEK_BASE_URL`, then the selected protocol default |
| `thinking` | `enabled` | Deployment policy; `disabled` locks every request to `off` |
| `reasoningEffort` | `high` | Default effort: `off`, `low`, `high`, or `max` |
| `maxTokens` | `256,000` | Per-request output cap; a model's own cap and explicit request values win |
| `defaultContextWindow` | `1,000,000` | Capacity fallback for models without an exact value |
| `models` | V41 Flash + V4 Flash + V4 Pro + V4 Flash Vision Exp | Advisory catalog shown by discovery consumers |
| `streamIdleTimeoutMs` | `300,000` | Maximum provider idle time per outstanding stream read |
| `maxRequestFilesBytes` | `128 MiB` | File-mode request-image byte budget; a request whose retained images exceed it fails with `IMAGE_OFFLOAD_REQUIRED` |
| `maxInlineRequestImageBytes` | `20 MiB` | Independent base64 fallback high watermark |
| `maxImagesPerRequest` | `600` | High watermark for retained request-image count |
| `imageOffloadByteQuantum` | `64 MiB` | Files-mode oldest-prefix removal quantum |
| `inlineImageOffloadByteQuantum` | `10 MiB` | Inline-mode oldest-prefix removal quantum |
| `imageOffloadCountQuantum` | `20` | Count-overflow removal quantum |
| `filesApiTimeoutMs` | `60,000` | Per-image Files resolution deadline |
| `fileExpiresAfterSeconds` | `604,800` | Requested uploaded-image lifetime and local reuse bound |
| `fileRefreshMarginSeconds` | `3,600` | Remaining reuse lifetime below which an id is replaced |
| `fileQuotaCleanupBatch` | `100` | Oldest harness-owned files removed before one quota retry |
| `retryPolicy` | normal, 5 retries | Provider-owned retry policy executed by `dsh-llm-retry` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-deepseek) is the exhaustive source for every accepted field and its JSDoc.

<a id="choose-a-protocol"></a>
### Choose a protocol

To select Chat Completions explicitly, patch the existing plugin:

```yaml
- id: llm-deepseek
  config:
    protocol: chat-completions
```

`protocol` defaults to `messages`, with official root `https://api.deepseek.com/anthropic`; `chat-completions` uses `https://api.deepseek.com`. Shipped first-party compositions inherit this default. Neither protocol requires `baseURL`: its official default applies when both `baseURL` and `$DEEPSEEK_BASE_URL` are absent. Switching protocols retains endpoint overrides, so users must supply an address compatible with the selected protocol. An explicit `https://api.deepseek.com` override selects the Chat root: remove that override to use the official Messages default, or set it to `https://api.deepseek.com/anthropic`. Chat appends `/chat/completions`. Messages and its Files API treat only an exact final `/v1` path segment as the existing Anthropic API version and append `/messages` or `/files`; every other base receives `/v1/messages` or `/v1/files`. The official Messages root therefore retains its recommended `/anthropic/v1` request paths without granting compatibility to arbitrary version-like suffixes. Trailing slashes do not change these results. Both protocols share the `llm-deepseek` settings section, `apiKeyEnv`, and `deepseek-official`, so saved model selections remain valid.

Messages sends text, thinking, tool calls, and tool results as content blocks, reasoning effort as `output_config.effort`, and images as Files references or inline base64. Models declaring `systemPromptUpdate: in-history` retain the initial top-level system and send new system snapshots after their corresponding user/tool-result turn; undeclared models use the latest snapshot as the top-level system. Replay metadata identifies the Messages format, model, and signatures. Chat requests serialize durable content without those signatures. Invalid Messages replay metadata emits a warning and omits signatures while retaining text and tool history.

### Streaming with thinking and images

An image-capable route chooses each durable reference's request target and resolves it into a deterministic request version. Omitting `imagePixelBudget` sizes the target on the published vision token grid of 14px patches, 3:1 downsampling, and at most 1024 tokens per image, so a square image keeps up to 1302×1302 pixels and a 16:9 image is sent as 1708×961 for the provider's 1708×966 grid; a positive integer replaces the grid with a total-pixel budget, and `low` uses 512×512 total pixels. Every request image is capped at 4096 pixels per side, the provider limit for requests carrying 15 or more images, and `imageMaxBytes` defaults to 2 MiB. Alpha images use WebP effort 0 and opaque images use JPEG on the 85/75/60 quality ladder, keeping the smallest output when every candidate exceeds the target. Every retained image is preceded by text naming its complete attachment id and actual request dimensions. When the current filesystem maps the attachment provider's host object, that text also carries a read-only execution-world path and the extension for a writable copy. Text-only and unlisted routes receive stable attachment placeholders while durable history keeps the image references.

Both protocols normally upload those exact request bytes through their DeepSeek Files endpoint and send file-id references. Messages uses `/v1/files` under its configured base and includes `anthropic-beta: files-api-2025-04-14` on Files requests and Messages requests containing file ids; Chat uses `/files`. Messages model requests and all Files requests reject redirects so credentials remain on the configured origin. A failed or timed-out file resolution rebuilds the whole model request with inline base64 under the inline budget; one request never mixes file ids and inline images. Caller cancellation stops the request.

Cached ids are scoped by endpoint and API key, refreshed before expiry, invalidated from provider stale-file errors, and resolved through singleflight with waiter-local cancellation. Both uploads request expiry through `expires_after[anchor]=created_at` and `expires_after[seconds]`. Messages file metadata omits remote expiry, so its local reuse deadline uses the original upload time plus `fileExpiresAfterSeconds`; this does not guarantee remote deletion. Quota failure deletes one configured batch of the oldest harness-owned files before one upload retry.

Files mode bounds retained request versions by `maxRequestFilesBytes` and `maxImagesPerRequest`; inline fallback has its own base64 budget. Both remove an oldest prefix in configured byte or count quanta. Each omitted image gets its own model-visible placeholder with its display name or attachment id and, when available, normalized dimensions, media type, and current read-only path. The stepped high-watermark policy avoids rewriting an old request prefix after every new image.

`reasoningEffort` selects the advertised default. Exact-model metadata exposes ordered `off`, `low`, `high`, and `max` efforts with selection guidance when deployment policy permits thinking. `low`, `high`, and `max` enable thinking and serialize as `reasoning_effort` for Chat Completions or `output_config.effort` for Messages, while adapter-owned `off` sends `thinking.type: disabled` instead. An unsupported value fails with `UNSUPPORTED_REASONING_EFFORT` before network I/O, and `thinking: disabled` rejects any non-`off` effort at plugin load. Requests with `purpose: 'session-title'` force thinking off to reserve output for visible title text. Both protocols forward an explicit `temperature`; DeepSeek accepts it with thinking enabled but ignores its value in that mode.

### Dynamic configuration

Connection facts are re-read once per operation through the optional settings and credentials seams. A `llm-deepseek:` section in the user settings document overrides any field without a restart; a snapshot that fails a beyond-schema bound keeps the last good facts and logs the failure. The API key resolves per stream call from the same snapshot that supplies the endpoint, image and Files policies, and idle budget, so a rejected settings generation contributes none of them. Image requests resolve the attachment service at request time, so load order does not freeze image availability.

### Provider-specific request fields

For either protocol, when `ctx.deepseekLlmApiExtensions` is present, the adapter prepares its registered top-level fields from the exact serialized base request before `fetch`. Preparation or field collisions fail before HTTP; after a 2xx response, the adapter accepts every captured contribution before consuming SSE. Transport and non-2xx failures do not accept them. Shipped compositions use this for the default-on incremental `dsh_session_log` field and the default-on active `dsh_plugin_packages` inventory; both stay outside model input.

### Failures and recovery

Non-2xx responses fail with stable codes: `AUTH` (401/403), `QUOTA`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`, and `HTTP_<status>` otherwise; pre-response transport failures throw `TRANSPORT`, caller aborts throw `ABORTED`, and stream-idle expiry throws `TIMEOUT`. Request-extension preparation, field collision, or post-2xx acceptance fails with `REQUEST_EXTENSION`. A normalized-image rejection names every plausible attachment and its durable position when the provider does not identify a file id. Stale-file rejection invalidates the named mappings (or every mapping used by the attempt) and permits one replacement model request. Protocol violations throw `STREAM_CLOSED` or `MALFORMED_RESPONSE`, and a terminal `stop` with no content blocks becomes `EMPTY_RESPONSE`, which the default retry policy retries. A request with no key anywhere fails with `MISSING_CREDENTIAL`, and a malformed credential fails with `INVALID_CREDENTIAL` naming the reference to fix — never any part of the key.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the adapter; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The plugin is built on one explicit resolve step and one registration fact. `resolveAdapterOptions()` is the single path from raw config to validated connection facts, and the adapter re-reads those facts through a thunk once per operation — base URL, catalog, request defaults, image and Files policies, and idle budget all take effect on the next request, while an in-flight stream keeps the facts it started with. The only fact captured at registration is the retry policy: when its resolved value changes, the plugin re-registers the route in place, in one synchronous section, so no request observes a gap.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Settings, credentials, and provider registration |
| [`src/config.ts`](src/config.ts) | Schema and request-local configuration resolution |
| [`src/adapter.ts`](src/adapter.ts) | Protocol dispatch with frozen prepared-call configuration |
| [`src/common/models.ts`](src/common/models.ts) | Shared model catalog |
| [`src/common/model-info.ts`](src/common/model-info.ts) | Shared model capabilities and reasoning choices |
| [`src/common/file-store.ts`](src/common/file-store.ts) | Shared Files cache, refresh, quota cleanup, and cancellation |
| [`src/common/files-api.ts`](src/common/files-api.ts) | Protocol-specific Files endpoints and response mapping |
| [`src/protocols/chat-completions/adapter.ts`](src/protocols/chat-completions/adapter.ts) | Chat transport, image projection, and request extensions |
| [`src/protocols/messages/adapter.ts`](src/protocols/messages/adapter.ts) | Messages transport, image projection, request extensions, and native replay |

### Wire flow

One `stream()` call normally makes one model request: resolve deterministic request images, prefer Files ids, prepare any registered top-level request extensions, fetch from the resolved `baseURL`, accept extension transactions after HTTP 2xx, and translate the SSE stream into the harness protocol. File-resolution failure makes the first request inline; a provider stale-file response permits one replacement attempt, also inline if replacement resolution fails. Every model and Files call carries shared attribution. Model requests also carry the stable anonymous user id outside model input, plus a session id when present. Reasoning history is serialized back when required, and cache accounting maps DeepSeek's cache-hit metrics into harness usage.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the service contract to the twin adapter, the retry executor, and the shared types.

- [dsh-llm service](../llm/README.md) — the provider-neutral service this adapter registers on.
- [llm-pi-ai adapter](../llm-pi-ai/README.md) — the library-backed twin serving other providers and gateways.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract.
- [llm-retry](../llm-retry/README.md) — the retry executor that applies this adapter's `retryPolicy`.
- [DeepSeek request extensions](../deepseek-llm-api-extensions/README.md) — lifecycle and acceptance semantics for provider-specific top-level fields.
- [Session-log upload](../../session/session-log-deepseek/README.md) — the default-on incremental `dsh_session_log` contribution.
- [Plugin package inventory](../plugin-package-inventory-deepseek/README.md) — the default-on `dsh_plugin_packages` contribution.
- [Twin LLM adapters](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) — why DeepSeek ships two structurally different adapters.
- [Mandatory app attribution headers](../../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md) — the identity every provider request carries.

-----

<a id="model-experience"></a>
## Model Experience

### DeepSeek request

#### What the model sees

The selected DeepSeek model receives the harness system prompt, message history, tool schemas, stop sequences, and call config (`maxTokens`, `reasoningEffort`, `temperature`) without adapter-authored prompt prose. Provider-specific request-extension fields remain outside model input. The vision model normally receives retained user and tool-result images as Files API references beside attachment handles and request-preview dimensions. It also receives a normalized-object path when the current execution filesystem maps the attachment provider's host object; the descriptor marks this copy read-only and warns that normalization may have resized or re-encoded the upload. A Files resolution failure sends all retained images as inline base64 instead, and an over-budget older image keeps the access resolved for that request in its placeholder. Reasoning content from a prior assistant turn is passed back verbatim, whether or not that turn called a tool.

#### Token effect

Provider tokenization governs exact text and image-token input. The adapter declares per-route `imageRequestPricing`: it prices each occurrence selected by a logged image-offload decision as its placeholder text and each retained image at its projected dimensions with the published vision accounting (14px patch grid, 3:1 downsampling, 544×544 scale-up floor, 1024-token cap). This lets the token meter price image pressure before a request; reported usage remains authoritative. Reasoning passback carries every reasoned turn's chain of thought into later requests, while offloaded images stop costing visual tokens. A request whose retained occurrences exceed the file-mode or inline-fallback budget (`maxRequestFilesBytes`, `maxImagesPerRequest`, both quanta) at their exact request-version bytes fails with `IMAGE_OFFLOAD_REQUIRED` naming the additional oldest occurrences to offload, and `dsh-compaction-image-offload` records the selected occurrences in an `image/offload` event and retries. Cache-read usage is reported when available. Messages totals include uncached input, output, cache-read, and cache-write tokens. Chat Completions uses `prompt_tokens + completion_tokens` and omits `totalTokens` if a supplied `total_tokens` disagrees.

#### KV Cache effect

An unchanged assembled prefix is eligible for DeepSeek cache reuse, which this adapter reports in usage. Deterministic request-image bytes do not make the full prefix immutable: a changed execution-world path rewrites historical descriptor text, a refreshed upload can replace a `file_id`, and Files-to-base64 fallback changes the image representation. Any of these, or a model-route, prompt, schema, history, or image-budget change, may prevent reuse from the first affected token; reasoning passback appends on every reasoned turn. On a catalog entry declaring `systemPromptUpdate: in-history`, a system prompt change inside a continuing request series is appended after the cached history, so the prefix through that history stays reusable; a tool-schema change still prevents reuse from the first altered token.

### DeepSeek response

#### What the model sees

Reasoning, text, and raw-string tool arguments are translated into harness chunks for the loop to log and assemble.

#### Token effect

Generated tokens follow the request's logged reasoning effort and `maxTokens`; only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect. Changing the provider or model selects a different cache domain.

## Known Limitations and Deferred Work

- Responses is not implemented; configuration rejects `responses`.

<a id="known-limitations-and-deferred-work"></a>


These limits define where the adapter stops and future work begins. They are current package constraints, not a general DeepSeek comparison or a task backlog.

- **A settings `models` list replaces the composition list wholesale** — settings-layer merging is per-field, and arrays are one field; per-entry catalog merging would need a keyed shape.
- **`tool_choice` is not mapped** — not part of the core vocabulary (shared with the pi-ai twin).
- **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy or interception configuration.
- **Plugin-added content block types are skipped** — core text and supported image blocks are serialized, and empty tool output crosses the wire as the literal `(no output)`.
- **Images are input-only durable attachments** — direct external URLs and assistant image output are not supported; DeepSeek input normally uses the Files API and uses inline base64 only for per-request recovery.
- The default catalog pre-registers `deepseek-flash` and its text/image and in-history capabilities without probing gateway availability. Requests can fail with `INVALID_REQUEST` until the gateway enables the id. With `DEEPSEEK_API_KEY` and a supporting gateway configured, `DEEPSEEK_FLASH_E2E=1` enables the Chat Completions check in [this package's e2e suite](tests/adapter.e2e.ts).
- The [Messages system-update e2e checks](tests/messages/adapter.e2e.ts) require `DEEPSEEK_IN_HISTORY_MODEL` to name a supported model, such as `deepseek-flash`, and run with `high` effort. They skip when that variable is unset or empty; ordinary `off` text checks remain enabled with credentials. Known instruction-following instability with thinking disabled makes these system-update checks unsuitable for `off`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- OpenRouter-specific app attribution headers are deferred to a future explicit OpenRouter adapter or mode; OpenAI-compatible gateway requests carry only the shared attribution baseline.
- The `off` reasoning effort never crosses the wire as `reasoning_effort: 'off'`; it serializes as `thinking: { type: 'disabled' }` and omits the field, which keeps the wire spelling valid for gateways that reject unknown effort values.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
