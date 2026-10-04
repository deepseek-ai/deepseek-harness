---
description: "Configure DeepSeek Messages, reasoning, and image input."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek

English | [中文](README.zh.md)

## Summary

Provide the shared DeepSeek Messages transport, request configuration, and model capabilities. Compose [API-key](../llm-deepseek-api-key/README.md) or [account](../llm-deepseek-account/README.md) plugins for authentication, model discovery, and provider registration. Valid settings changes affect subsequent calls while in-flight calls retain their configuration. This package can run beside the [pi-ai adapter](../llm-pi-ai/README.md).

`resolveAuth(connection)` returns the provider-owned authentication headers and an optional failure callback bound to that request’s credential. Messages and Files send those headers without selecting a credential mode. Upload reuse is isolated by endpoint and a hash of the authentication headers; raw credentials are not persisted.

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

This package exports the transport library; the provider plugins register routes with the harness LLM service. It captures connection options from Config references once per operation.

The adapter accepts the LLM service's [request-only user inputs](../llm/README.md#use-this-package) alongside durable history; omitting request-only identity and attribution does not alter provider content.

### When to choose it

Choose this adapter for DeepSeek's official API or a Messages-compatible gateway through `baseURL`. Choose `dsh-llm-pi-ai` when the same composition also routes other providers or hand-declared gateways through pi-ai's catalogs; the two adapters can be mounted together because their route names do not collide. Registering any other adapter for `deepseek-official` fails with `DUPLICATE_ADAPTER`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY  # credential reference, resolved per request
    reasoningEffort: high        # optional; off | low | high | max
    maxTokens: 256000            # optional per-request output cap
    maxRequestFilesBytes: 134217728
    maxInlineRequestImageBytes: 20971520
    maxImagesPerRequest: 600
    filesApiTimeoutMs: 60000
```

A request selects the route with `provider: deepseek-official`; the model id passes through to the wire, so new DeepSeek models need no re-registration. Omitted `models` advertises the text- and image-capable `deepseek-flash` alongside the text-only `deepseek-v4-pro`, each with a 1,000,000-token context window. An explicit list replaces those defaults, and core calls still pass unlisted model ids through as text-only routes. GUI selection requires a catalog entry; a saved selection can still submit requests after its catalog entry disappears. Clients, including model discovery tools, can read the advisory entries through `ctx.llm.listModels('deepseek-official')`. Image-capable entries may set `imagePixelBudget` to a positive integer or `low`, and may set `imageMaxBytes`. An entry may declare `systemPromptUpdate: in-history` when its endpoint reads the latest `system` message at any position of `messages` as the complete effective system prompt; the adapter reports the mode on the resolved model and the prepared call, and the agent loop then appends a changed prompt after the cached history instead of rewriting the leading system message ([decision rule](../../core/agent-loop/README.md#understand-the-implementation)). The default `deepseek-flash` entry declares this mode; other models require an explicit `models` declaration, and any value other than `in-history` fails at load with `llm-deepseek: catalog model "<id>" systemPromptUpdate must be "in-history" when present`.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://api.deepseek.com/anthropic` | Explicit value, then `$DEEPSEEK_BASE_URL`, then the official root |
| `thinking` | `enabled` | Deployment policy; `disabled` locks every request to `off` |
| `reasoningEffort` | `high` | Default effort: `off`, `low`, `high`, or `max` |
| `maxTokens` | `256,000` | Per-request output cap; a model's own cap and explicit request values win |
| `defaultContextWindow` | `1,000,000` | Capacity fallback for models without an exact value |
| `models` | V41 Flash + V4 Pro | Advisory catalog shown by discovery consumers |
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

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-deepseek-api-key) is the exhaustive source for every accepted field and its JSDoc.

When [proactive compaction](../../compaction/compaction-basic/README.md#use-this-package) is enabled, `models[].contextWindow` (or `defaultContextWindow` when absent) must exceed the effective request `maxTokens` plus the compaction policy’s `headroomTokens`. Requests without an explicit output cap use the model’s `maxTokens` or the adapter default. For small-window deployments, configure headroom within that capacity; lower `thresholdRatio` to compact earlier.

<a id="endpoint-and-wire-format"></a>
### Endpoint and wire format

The official root is `https://api.deepseek.com/anthropic`. An explicit `baseURL` or `$DEEPSEEK_BASE_URL` supplies a Messages-compatible root. Model and Files requests append `/v1/messages` and `/v1/files`, except that an exact final `/v1` segment is reused. Trailing slashes do not change these results. A base URL must use HTTP(S) without credentials, query, or fragment.

Messages sends text, thinking, tool calls, and tool results as content blocks, reasoning effort as `output_config.effort`, and images as Files references or inline base64. Models declaring `systemPromptUpdate: in-history` retain the initial top-level system and send new system snapshots after their corresponding user/tool-result turn; undeclared models use the latest snapshot as the top-level system. Replay metadata preserves the model and thinking signatures. Invalid replay metadata emits a warning and omits signatures while retaining text and tool history. Model entries may declare `toolUpdate: addition-only` or `in-history`; the default `deepseek-flash` entry declares `addition-only`. Projected developer tool updates become system-role `tool_addition` and `tool_removal` blocks referencing declared names, and deferred declarations carry `defer_loading`. Requests containing those blocks send the `mid-conversation-tool-changes-2026-07-01` beta header.

### Account credentials

`deepseek-official` resolves only its configured API-key reference. `deepseek-account` resolves only the stored grant from the [account provider](../../credentials/deepseek-account-platform/README.md), whose allowed `inferenceOrigin` defaults to `https://api.deepseek.com`. Neither route falls back to the other. Signing out removes the account grant and preserves API keys.

Messages and Files requests send account tokens as `x-dsh-auth-token` without a Bearer prefix; API keys use `x-api-key`. Neither credential mode follows redirects. The account provider owns HTTP 401 classification and credential invalidation; the transport passes failures to its callback.

### Streaming with thinking and images

An image-capable route chooses each durable reference's request target and resolves it into a deterministic request version. Omitting `imagePixelBudget` sizes the target on the published vision token grid of 14px patches, 3:1 downsampling, and at most 1024 tokens per image, so a square image keeps up to 1302×1302 pixels and a 16:9 image is sent as 1708×961 for the provider's 1708×966 grid; a positive integer replaces the grid with a total-pixel budget, and `low` uses 512×512 total pixels. Every request image is capped at 4096 pixels per side, the provider limit for requests carrying 15 or more images, and `imageMaxBytes` defaults to 2 MiB. Alpha images use WebP effort 0 and opaque images use JPEG on the 85/75/60 quality ladder, keeping the smallest output when every candidate exceeds the target. Every retained image is preceded by text naming its complete attachment id and actual request dimensions. When the current filesystem maps the attachment provider's host object, that text also carries a read-only execution-world path and the extension for a writable copy. Text-only and unlisted routes receive stable attachment placeholders while durable history keeps the image references.

The adapter normally uploads those exact request bytes through `/v1/files` and sends file-id references. Files requests and model requests containing file ids include `anthropic-beta: files-api-2025-04-14`. All requests reject redirects so credentials remain on the configured origin. A failed or timed-out file resolution rebuilds the whole model request with inline base64 under the inline budget; one request never mixes file ids and inline images. Caller cancellation stops the request.

Cached ids are scoped by endpoint and credential, refreshed before expiry, invalidated from provider stale-file errors, and resolved through singleflight with waiter-local cancellation. Uploads request expiry through `expires_after[anchor]=created_at` and `expires_after[seconds]`. Messages file metadata omits remote expiry, so its local reuse deadline uses the original upload time plus `fileExpiresAfterSeconds`; this does not guarantee remote deletion. Quota failure deletes one configured batch of the oldest harness-owned files before one upload retry.

Files mode bounds retained request versions by `maxRequestFilesBytes` and `maxImagesPerRequest`; inline fallback has its own base64 budget. Both remove an oldest prefix in configured byte or count quanta. Each omitted image gets its own model-visible placeholder with its display name or attachment id and, when available, normalized dimensions, media type, and current read-only path. The stepped high-watermark policy avoids rewriting an old request prefix after every new image.

`reasoningEffort` selects the advertised default. Exact-model metadata exposes ordered `off`, `low`, `high`, and `max` efforts with selection guidance when deployment policy permits thinking. `low`, `high`, and `max` enable thinking and serialize as `output_config.effort`, while adapter-owned `off` sends `thinking.type: disabled` instead. An unsupported value fails with `UNSUPPORTED_REASONING_EFFORT` before network I/O, and `thinking: disabled` rejects any non-`off` effort at plugin load. Requests with `purpose: 'session-title'` force thinking off to reserve output for visible title text. The adapter forwards an explicit `temperature`; DeepSeek accepts it with thinking enabled but ignores its value in that mode.

### Dynamic configuration

Connection options are captured from volatile Config references once per operation. Config validation rejects invalid candidates before form persistence. Credentials resolve from the same snapshot as the endpoint, image and Files policies, and idle budget. Attachment services resolve at request time.

### Provider-specific request fields

When `ctx.deepseekLlmApiExtensions` is present, the adapter prepares its registered top-level fields from the exact serialized base request before `fetch`. Preparation or field collisions fail before HTTP; after a 2xx response, the adapter accepts every captured contribution before consuming SSE. Transport and non-2xx failures do not accept them. When the base request with its extension fields fails to serialize, the adapter sends the base request alone, skips acceptance so contributors resend their state later, and logs a warning naming the omitted fields. Shipped compositions use this for the default-on incremental `dsh_session_log` field and the default-on active `dsh_plugin_packages` inventory; both stay outside model input.

### Failures and recovery

Configuration accepts Messages only and has no `protocol` field. If resolution reports `protocol is not configurable`, remove `protocol` from the `config` of the `llm-deepseek` entry in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` and from any overriding home patch or command-line overlay. Keep the intended `baseURL`, `apiKeyEnv`, and `models` fields. A stored configuration rejected by adapter validation makes subsequent requests fail until corrected; saving other fields in the Models card does not remove an unknown property. Edit the configuration file, then let the profile reload it through HMR or restart the profile if HMR is disabled.

Successful Files responses must contain valid JSON. JSON decoding failures from upload, list, retrieve, and delete throw `INVALID_RESPONSE` with the operation and HTTP status in the message, the status in `LlmError.failure`, and the original parser error as `cause`. Body-read transport and cancellation errors retain their identity.

Non-2xx responses fail with stable codes: `AUTH` (401/403), `QUOTA`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`, and `HTTP_<status>` otherwise; pre-response transport failures throw `TRANSPORT`, caller aborts throw `ABORTED`, and stream-idle expiry throws `TIMEOUT`. Request-extension preparation, field collision, or post-2xx acceptance fails with `REQUEST_EXTENSION`. A normalized-image rejection names every plausible attachment and its durable position when the provider does not identify a file id. Stale-file rejection removes every named mapping (or every mapping used by the attempt) in one upload-index update and permits one replacement model request. Protocol violations throw `STREAM_CLOSED` or `MALFORMED_RESPONSE`, and a terminal `stop` with no content blocks becomes `EMPTY_RESPONSE`, which the default retry policy retries. A request on the official route without an API key fails with `MISSING_CREDENTIAL`, and a malformed credential fails with `INVALID_CREDENTIAL` naming the reference to fix — never any part of the key.

Provider plugins own catalog availability; only the account route requires a stored grant for discovery. Their catalogs are configured independently; the transport supplies shared default model metadata and capability resolution.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the adapter; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The plugin is built on one explicit resolve step and one registration fact. `resolveAdapterOptions()` is the single path from raw config to validated connection facts, and the adapter re-reads those facts through a thunk once per operation — base URL, catalog, request defaults, image and Files policies, and idle budget all take effect on the next request, while an in-flight stream keeps the facts it started with. The only fact captured at registration is the retry policy: when its resolved value changes, the plugin re-registers the route in place, in one synchronous section, so no request observes a gap.

### Source map

[`src/index.ts`](src/index.ts) exports the protocol library; [`src/host.ts`](src/host.ts) binds shared Host services for provider plugins. [`src/adapter.ts`](src/adapter.ts) owns the request lifecycle; [`src/serialize.ts`](src/serialize.ts) and [`src/translate.ts`](src/translate.ts) map model input and streamed output. [`src/file-store.ts`](src/file-store.ts) owns upload reuse and recovery through [`src/files-api.ts`](src/files-api.ts).

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
- [Mandatory app attribution headers](../../../docs/subsystems/llm-streaming.md) — the identity every provider request carries.

-----

<a id="model-experience"></a>
## Model Experience

### DeepSeek request

#### What the model sees

The selected DeepSeek model receives the harness system prompt, message history, tool schemas, stop sequences, and call config (`maxTokens`, `reasoningEffort`, `temperature`) without adapter-authored prompt prose. Provider-specific request-extension fields remain outside model input. The vision model normally receives retained user and tool-result images as Files API references beside attachment handles and request-preview dimensions. It also receives a normalized-object path when the current execution filesystem maps the attachment provider's host object; the descriptor marks this copy read-only and warns that normalization may have resized or re-encoded the upload. A Files resolution failure sends all retained images as inline base64 instead, and an over-budget older image keeps the access resolved for that request in its placeholder. Reasoning content from a prior assistant turn is passed back verbatim, whether or not that turn called a tool. Messages sends `{}` for historical tool arguments that are malformed JSON or are not objects. This argument fallback preserves call ids, tool names, and tool results; the original arguments stay in the Session log. Newly generated Messages tool arguments still require valid JSON objects. Messages omits `reasoning` and `tool-call` blocks inside user messages and tool results. This also permits replay of saved subagent notices containing assistant output; the original Session content remains intact. Empty user messages are skipped after conversion, while empty tool results retain their call ids and error flags. Other unsupported input blocks still fail with `UNSUPPORTED_CONTENT`.

#### Token effect

Provider tokenization governs exact text and image-token input. The adapter declares per-route `imageRequestPricing`: it prices each occurrence selected by a logged image-offload decision as its placeholder text and each retained image at its projected dimensions with the published vision accounting (14px patch grid, 3:1 downsampling, 544×544 scale-up floor, 1024-token cap). This lets the token meter price image pressure before a request; reported usage remains authoritative. Reasoning passback carries every reasoned turn's chain of thought into later requests, while offloaded images stop costing visual tokens. A request whose retained occurrences exceed the file-mode or inline-fallback budget (`maxRequestFilesBytes`, `maxImagesPerRequest`, both quanta) at their exact request-version bytes fails with `IMAGE_OFFLOAD_REQUIRED` naming the additional oldest occurrences to offload, and `dsh-compaction-image-offload` records the selected occurrences in an `image/offload` event and retries. Cache-read usage is reported when available. Messages totals include uncached input, output, cache-read, and cache-write tokens.

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


<a id="known-limitations-and-deferred-work"></a>


These limits define where the adapter stops and future work begins. They are current package constraints, not a general DeepSeek comparison or a task backlog.

- **Replacing `models` replaces the complete catalog list** — use path edits when changing one model entry.
- **`tool_choice` is not mapped** — not part of the core vocabulary (shared with the pi-ai twin).
- **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy or interception configuration.
- **Messages in-history system updates require a retained user or tool-result turn** — if all user input after an update is omitted and the preceding wire turn is assistant, serialization fails with `UNSUPPORTED_CONTENT` before the next assistant or at the end of the request. Text or an empty tool result can retain that turn. Moving the update to an earlier turn is not supported; the [input-history reference](README.md) records the ordering constraint.
- **Images are input-only durable attachments** — direct external URLs and assistant image output are not supported; DeepSeek input normally uses the Files API and uses inline base64 only for per-request recovery.
- The default catalog advertises `deepseek-flash` and its text/image and in-history capabilities without probing gateway availability. Requests can fail with `INVALID_REQUEST` until the gateway enables the id.
- Real API checks in [adapter.e2e.ts](tests/adapter.e2e.ts) and [runtime.e2e.ts](tests/runtime.e2e.ts) require `DEEPSEEK_API_KEY`. Set `DEEPSEEK_IN_HISTORY_MODEL` to a supported nonempty model id to run system-update checks: the adapter suite uses `high` effort, while the runtime suite compares cache reuse with thinking disabled and can be sensitive to instruction-following instability. The runtime image cases additionally require `DEEPSEEK_FLASH_E2E=1` or `DEEPSEEK_VISION_E2E=1`.

<a id="dev-note"></a>
### Dev Note

None.

`deepseek-official` uses only its configured API-key reference; `deepseek-account` uses only the stored DSH grant for the account provider’s allowed inference origin. Both routes share the Messages transport with independently configured model and file settings. Missing or ineligible account credentials reject the request with a sign-in prompt; neither route falls back to the other. Chat and Files requests reject redirects. The account provider owns sign-out cancellation using running Agents’ logged request contexts, including tool execution; the transport receives the existing request abort signal.
