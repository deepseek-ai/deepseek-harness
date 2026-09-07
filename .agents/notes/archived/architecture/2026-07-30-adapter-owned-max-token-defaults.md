# Agent Note: Adapter-owned max-token defaults

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-adapter-owned-max-token-defaults.zh.md)

## Problem

An LLM adapter could serialize an explicit `GenerateOptions.maxTokens`, but its Cordis configuration could not establish a reconstructable conversation default. Applying a fallback only inside provider serialization would make the wire request differ from the durable `request/header`; putting every provider's default in Agent Loop would instead transfer deployment and model policy into the provider-neutral driver.

## Decision

`LlmResolvedModelInfo.defaultMaxTokens` carries an optional adapter-configured per-request output cap for one exact provider/model route. `LlmRuntime` validates it as a positive safe integer and materializes it into `LlmCallConfig.maxTokens` only when the caller omitted a value. A prepared call identifies materialized `maxTokens` and `reasoningEffort` fields as adapter defaults; explicit request or Agent options remain unmarked and therefore win without clamping.

The agent loop continues to prepare calls before logging `request/header`, so the effective config and markers for fields supplied by adapter defaults become durable request facts before dispatch. Before the next `agent/request` waterfall, the loop removes marked fields from the proposal; exact-model resolution then materializes the current route's defaults again. A provider/model switch therefore cannot mistake a previous adapter's default for an explicit override, while explicit conversation values persist. Direct `LlmRuntime.stream()` calls resolve the same default at the final adapter boundary. The field is a request default rather than a hard model output limit; adapters that preserve provider-owned defaults omit it.

The native DeepSeek adapter exposes `maxTokens` in Cordis config with a 256,000-token default and maps the effective value to `max_tokens`. Its default context capacity is 1,000,000 tokens: both built-in V4 entries publish that exact capacity, while configured entries without capacity and unlisted pass-through ids inherit the same adapter-wide fallback.

## Alternatives considered

**Apply the default only in DeepSeek serialization.** Rejected because the provider wire would contain a model-visible value absent from the durable request header.

**Set `AgentOptions.maxTokens` in every shipped application.** Rejected because applications would duplicate adapter deployment policy, direct LLM calls would behave differently, and selecting another provider would retain a DeepSeek-specific cap.

**Represent 256,000 as a hard per-model maximum.** Rejected because the configured value is the desired request budget, not evidence that every configured endpoint rejects larger outputs. Explicit callers remain authoritative.

**Leave the provider default in control.** Rejected for the native DeepSeek deployment because the product requires a stable 256,000-token conversation budget across compatible endpoints.

## Consequences

DeepSeek conversations send `max_tokens: 256000` by default, and the session request header records both the value and that the adapter supplied it. Deployments can change the adapter default through `llm-deepseek.config.maxTokens`; per-agent and per-request values override it. Changing the route rematerializes the new exact adapter's default instead of carrying DeepSeek's derived value forward. Other adapters retain their existing behavior until they intentionally publish `defaultMaxTokens`.

The 256,000-token output budget reserves a large part of the one-million-token context on endpoints that pre-allocate requested output. Deployments whose gateway or model supports a smaller budget must lower `maxTokens`; the explicit configuration is preferable to an undocumented provider fallback.
