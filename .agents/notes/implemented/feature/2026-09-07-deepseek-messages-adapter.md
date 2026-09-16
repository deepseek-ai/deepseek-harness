# Agent Note: DeepSeek through the Anthropic Messages protocol

Status: implemented

English | [中文](2026-09-07-deepseek-messages-adapter.zh.md)

## Problem

Deployments expose DeepSeek through Anthropic Messages gateways as well as chat-completions. Messages represents thinking, signatures, tool calls, tool results, and cumulative usage differently. Translating only the endpoint or flattening assistant history loses information needed by subsequent tool turns.

## Decision

The [DeepSeek adapter](../../../../packages/llm/llm-deepseek/README.md) serves multiple protocols under one `deepseek-official` route and `llm-deepseek` settings namespace. `common/` shares configuration, the model catalog, capability resolution, and Files lifecycle; `protocols/chat-completions/` and `protocols/messages/` own serialization, stream conversion, and transport. Cordis YAML selects the implementation through `protocol`, defaulting to `messages`; shipped first-party compositions inherit that default. The existing `PreparedAdapterCall` freezes protocol, endpoint, credential reference, and model capabilities; retries retain that generation while subsequent calls read new configuration.

The adapter follows the [DeepSeek compatibility documentation](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) and [Anthropic streaming protocol](https://platform.claude.com/docs/en/build-with-claude/streaming). The pi-ai Anthropic implementation informed the handling of adjacent user messages, cumulative usage, fragmented tool arguments, and optional thinking signatures. DeepSeek effort uses `output_config.effort`; an Anthropic thinking token budget does not control DeepSeek effort. Both protocols forward explicit `temperature` values; DeepSeek accepts that parameter with thinking enabled and ignores its value, so callers retain their existing thinking configuration.

Assistant blocks remain the durable model-visible content. A versioned `ReplayEnvelope` stores only the protocol format, model identity, aligned block kinds, and signatures absent from those blocks. Same-model Messages continuation restores signatures verbatim, including empty signatures; foreign history carries no invented signature. Unusable metadata follows the existing [replay degradation rule](../architecture/2026-07-14-provider-routed-llm-adapters.md): the request omits signatures with a warning while preserving durable content; content validation such as tool argument parsing still fails explicitly. This keeps provider replay data opaque to the loop while preserving it through Session persistence and block pruning.

Both protocols prefer Files references for deterministic request images and share upload caching, refresh, quota recovery, and attachment offload. The Files client retains the selected protocol and configured endpoint: Messages follows the [exact `/v1` root rule](../bug-fix/2026-09-15-messages-v1-base-url.md), while Chat Completions appends `/files`. Messages Files requests carry the required beta header. Cached ids remain scoped by the resolved Files root and credential, so equivalent `/v1` and unversioned Messages roots share uploads. Messages metadata omits expiry, so local reuse is bounded from the original upload time without asserting remote deletion. A Files-resolution failure rebuilds the complete request under the independent inline-image budget; caller cancellation stops it. The shared image policy preserves the 128 MiB retained-image budget, 20 MiB inline base64 budget, and oldest-prefix offload in both requests and token measurement.

System updates use the existing [route capability](2026-09-02-in-history-system-prompt-replacement.md) when explicitly declared for an endpoint/model. Messages retains the initial top-level system and emits later snapshots as native system turns after the corresponding user/tool-result turn, preserving previously sent prefixes. This placement differs from the loop's system-before-user admission; serialization changes neither the durable log nor conversation-turn order. Undeclared routes consolidate the latest snapshot at the top level, including direct compaction calls. Capability inference from protocol or model names is insufficient because support and update semantics depend on the deployed endpoint.

Web always displays DeepSeek without a protocol selector. Both protocols share `baseURL` and `apiKeyEnv`, with no nested per-protocol configuration map. Without an endpoint override, resolution uses the selected protocol’s official default; Messages uses `https://api.deepseek.com/anthropic`. Switching retains existing endpoint overrides, whose compatibility belongs to the deployment. Messages follows the exact `/v1` root rule rather than inferring compatibility from other version-like suffixes. One model catalog includes `deepseek-flash` text/image and in-history system capabilities and retains the V4 entries. Explicit `chat-completions` remains supported with its own official default and appends `/chat/completions` without adding a version segment.

Both transports use the existing [request-extension registry](../architecture/2026-08-21-deepseek-llm-api-request-extensions.md) after native serialization and accept captured contributions after HTTP 2xx, before reading the stream. Session-log delivery and plugin inventory retain their owners and remain outside model input. The auxiliary [web-search provider](../../../../packages/web/web-search-deepseek/README.md) retains its separate endpoint, request, and settings.

## Alternatives considered

**Separate plugins per protocol.** This duplicates credentials, catalogs, settings cards, and provider identities, and forces users to reselect models when the wire protocol changes. Protocol folders inside one plugin retain implementation isolation; Responses can add an implementation without changing the user configuration structure.

**Delegate the new route to pi-ai or the Anthropic SDK.** Both provide maintained protocol implementations, but the requested direct adapter needs DeepSeek-specific configuration, attachment policy, credential resolution, and retry ownership. A small stream translator with a maintained SSE parser keeps these responsibilities explicit; the library-backed adapter remains available independently.

**Persist complete native responses or flatten thinking into text.** Full responses duplicate logged content and complicate truncation alignment. Flattening changes the next model input. Minimal aligned replay metadata preserves the missing protocol information without a new Session format.

**Always rewrite the top-level system prompt.** This discards the cache-preserving native update path on capable routes. Explicit capability selection keeps that path while retaining ordinary replacement for other endpoints; converting system instructions to user text would also lose their priority.

## Consequences

The package owns wire validation, stop-reason mapping, cancellation, and error classification, so protocol changes require adapter maintenance. Unsupported content and incomplete streams fail explicitly. The existing retry consumer owns retries; the existing assembler drops incomplete tool calls at the output limit. Messages defaults cover the shared base, Web, and standalone first-party compositions. Protocol changes preserve the provider id and saved model selections, but an explicit endpoint override must support the selected protocol.

Verification covers wire fixtures, real Loader composition, per-file unit coverage, [recorded Session replay](../../../../snapshots/session/deepseek-messages-replay/snapshot.yml) with [unknown replay versions](../../../../snapshots/session/deepseek-messages-degraded-replay/snapshot.yml), a Web Messages Session replay, and credential-gated text, thinking, tool continuation, image, and cancellation requests. Live gateway checks establish compatibility with the configured gateway; they do not establish compatibility with every Anthropic proxy.
