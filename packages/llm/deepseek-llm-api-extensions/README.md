---
description: "Official DeepSeek request-extension registry for provider plugins contributing lifecycle-owned top-level API fields."
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-llm-api-extensions

English | [中文](README.zh.md)

## Summary

Provider-specific registry for additive top-level fields and `x-deepseek-harness-` request headers on official DeepSeek LLM API requests. `DeepSeekLlmApiExtensionRegistry` registers `ctx.deepseekLlmApiExtensions`; contributor plugins claim one declaration-merged field or header, and `dsh-llm-deepseek` prepares the current contributions after serializing its base request. Use it when a plugin must add a validated provider-specific field or header without changing the base adapter.

## Table of Contents

- [Service](#service)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

- `register(field, provider)` reserves one field for the calling fiber. Duplicate or malformed names fail synchronously; disposing the registration releases it for a later provider.
- `prepare(request)` snapshots the registered providers, prepares them concurrently, clones and freezes returned JSON values, and returns `{ fields, accept }`. A provider whose preparation throws is omitted while the other fields are returned, and only its first failure is logged; request cancellation rejects and stops awaiting providers even when one ignores its signal.
- `accept()` runs every captured post-2xx callback once. Concurrent calls join the same settlement, every callback settles before failures are reported, and several failures become one `AggregateError`.
- `registerHeader(name, provider)` reserves one declaration-merged request header for the calling fiber. Its name must start with `x-deepseek-harness-` followed by hyphen-separated lowercase ASCII letters and digits. Malformed, duplicate, and built-in adapter names fail synchronously. Disposing a registration releases its name.
- `headers(request)` calls every registered header provider synchronously and returns the frozen values that are not `undefined`. A provider that throws, or returns anything other than non-empty printable ASCII without leading or trailing whitespace, is omitted from that request, and only its first omission is logged.

Each field provider sees the exact serialized Messages body, the request `AbortSignal`, plus optional `sessionId` and auxiliary-call `purpose`. It must stop its own work promptly after cancellation and returns `undefined` when its field does not apply to that request. A prepared operation retains the providers it captured even if HMR removes their registrations before HTTP acceptance. Header providers see only `sessionId` and `purpose`.

Request `purpose` is the producer-defined string forwarded by the adapter, or absent for ordinary conversation requests. The registry forwards unfamiliar purposes without choosing field-specific policy.

The registry owns addition and lifecycle, not field or header semantics. `@deepseek-ai/dsh-session-log-deepseek` owns `dsh_session_log` and the `x-deepseek-harness-session-type` and `x-deepseek-harness-subagent-parent-session-id` headers; `@deepseek-ai/dsh-plugin-package-inventory-deepseek` owns `dsh_plugin_packages`. The [DeepSeek wire reference](../../../docs/deepseek-llm-api-wire-extensions.md) defines their values. The provider-neutral LLM seam and `llm-pi-ai` do not consume this registry.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-llm-deepseek`, which sends registered fields and headers outside the model's `messages`, system prompt, and tool schemas.

#### KV Cache effect

None; registry fields and headers are model-hidden provider metadata and do not alter the serialized model-input prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Official DeepSeek requests only** — the registry intentionally has no provider-neutral routing or pi-ai adapter integration.
- **No field ordering contract** — JSON object member order follows registration preparation but receivers address fields by name.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
