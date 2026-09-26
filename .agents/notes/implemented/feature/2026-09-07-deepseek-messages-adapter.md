# Agent Note: DeepSeek through the Anthropic Messages protocol

Status: implemented

English | [中文](2026-09-07-deepseek-messages-adapter.zh.md)

## Problem

Messages represents thinking, signatures, tool calls, tool results, and cumulative usage as native protocol fields. Translating only the endpoint or flattening assistant history loses information needed by subsequent tool turns.

## Decision

The [DeepSeek adapter](../../../../packages/llm/llm-deepseek/README.md) serves Messages under one `deepseek-official` route and `llm-deepseek` settings namespace. The [single-protocol decision](../simplification/2026-09-19-deepseek-messages-only.md) owns the transport scope. `PreparedAdapterCall` freezes the endpoint, credential reference, and model capabilities; retries retain that generation while subsequent calls read new configuration.

The adapter follows the [DeepSeek compatibility documentation](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) and [Anthropic streaming protocol](https://platform.claude.com/docs/en/build-with-claude/streaming). The pi-ai Anthropic implementation informed the handling of adjacent user messages, cumulative usage, fragmented tool arguments, and optional thinking signatures. DeepSeek effort uses `output_config.effort`; an Anthropic thinking token budget does not control DeepSeek effort. The adapter forwards explicit `temperature` values; DeepSeek accepts that parameter with thinking enabled and ignores its value, so callers retain their existing thinking configuration.

Assistant blocks remain the durable model-visible content. A versioned `ReplayEnvelope` stores only the protocol format, model identity, aligned block kinds, and signatures absent from those blocks. Same-model Messages continuation restores signatures verbatim, including empty signatures; foreign history carries no invented signature. Unusable metadata follows the existing [replay degradation rule](../architecture/2026-07-14-provider-routed-llm-adapters.md): the request omits signatures with a warning while preserving durable content; historical tool arguments use the [empty-input fallback](../bug-fix/2026-09-16-messages-historical-tool-input.md) when Messages cannot represent them. This keeps provider replay data opaque to the loop while preserving it through Session persistence and block pruning.

The adapter prefers Files references for deterministic request images, with upload caching, refresh, quota recovery, and attachment offload. The Files client follows the [exact `/v1` root rule](../bug-fix/2026-09-15-messages-v1-base-url.md) and sends the required beta header. Cached ids remain scoped by the resolved Files root and credential, so equivalent `/v1` and unversioned roots share uploads. Metadata omits expiry, so local reuse is bounded from the original upload time without asserting remote deletion. A Files-resolution failure rebuilds the complete request under the independent inline-image budget; caller cancellation stops it. The image policy preserves the 128 MiB retained-image budget, 20 MiB inline base64 budget, and oldest-prefix offload in both requests and token measurement.

JSON syntax failure after a successful HTTP response does not establish a transport failure. Files decoding uses the existing `INVALID_RESPONSE` code with operation context instead of relabeling the failure as `TRANSPORT` or adding a retry; the [provider README](../../../../packages/llm/llm-deepseek/README.md) owns the error fields.

System updates use the existing [route capability](2026-09-02-in-history-system-prompt-replacement.md) when explicitly declared for an endpoint/model. Messages retains the initial top-level system and emits later snapshots as native system turns after the corresponding user/tool-result turn, preserving previously sent prefixes. This placement differs from the loop's system-before-user admission; serialization changes neither the durable log nor conversation-turn order. Undeclared routes consolidate the latest snapshot at the top level, including direct compaction calls. Capability inference from protocol or model names is insufficient because support and update semantics depend on the deployed endpoint.

Web displays DeepSeek with an endpoint and credential reference. Without an endpoint override, resolution uses `https://api.deepseek.com/anthropic`. Overrides must support Messages. The adapter follows the exact `/v1` root rule rather than inferring compatibility from other version-like suffixes. One model catalog advertises the capabilities declared by its entries.

The adapter uses the existing [request-extension registry](../architecture/2026-08-21-deepseek-llm-api-request-extensions.md) after native serialization and accepts captured contributions after HTTP 2xx, before reading the stream. Session-log delivery and plugin inventory retain their owners and remain outside model input. The auxiliary [web-search provider](../../../../packages/web/web-search-deepseek/README.md) retains its separate endpoint, request, and settings.

## Alternatives considered

**Separate Messages provider identity.** This duplicates credentials, catalogs, and settings cards, and forces users to reselect models when adopting Messages. The `deepseek-official` identity keeps those user choices stable.

**Delegate the new route to pi-ai or the Anthropic SDK.** Both provide maintained protocol implementations, but the requested direct adapter needs DeepSeek-specific configuration, attachment policy, credential resolution, and retry ownership. A small stream translator with a maintained SSE parser keeps these responsibilities explicit; the library-backed adapter remains available independently.

**Persist complete native responses or flatten thinking into text.** Full responses duplicate logged content and complicate truncation alignment. Flattening changes the next model input. Minimal aligned replay metadata preserves the missing protocol information without a new Session format.

**Always rewrite the top-level system prompt.** This discards the cache-preserving native update path on capable routes. Explicit capability selection keeps that path while retaining ordinary replacement for other endpoints; converting system instructions to user text would also lose their priority.

## Consequences

The package owns wire validation, stop-reason mapping, cancellation, and error classification, so protocol changes require adapter maintenance. User and tool-result input follows the [saved-input compatibility rule](../bug-fix/2026-09-18-messages-input-history-compatibility.md); other unsupported content and incomplete streams fail explicitly. The existing retry consumer owns retries; the existing assembler drops incomplete tool calls at the output limit. Messages serves the shared base, Web, and standalone first-party compositions. Explicit endpoint overrides must support Messages.

Verification covers wire fixtures, real Loader composition, per-file unit coverage, [recorded Session replay](../../../../snapshots/session/deepseek-messages-replay/snapshot.yml) with [unknown replay versions](../../../../snapshots/session/deepseek-messages-degraded-replay/snapshot.yml), a Web Messages Session replay, and credential-gated text, thinking, tool continuation, image, and cancellation requests. Live gateway checks establish compatibility with the configured gateway; they do not establish compatibility with every Anthropic proxy.
