# Agent Note: SDK max output tokens

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-sdk-max-output-tokens.zh.md)

## Problem

The Python and TypeScript SDKs could select a provider and model but could not bound conversation-model output. The runtime therefore omitted `GenerateOptions.maxTokens`, leaving provider defaults in control even when an evaluation host required a fixed output budget. `compaction-basic.maxTokens` could not fill this role because it limits only compaction-summary calls.

## Decision

The high-level SDKs expose one optional process-wide output cap: Python names it `max_tokens`, TypeScript names it `maxTokens`, and the shared `initialize` wire payload carries `maxTokens`. The JSON-RPC server rejects values that are not positive safe integers and stores the accepted cap with its provider/model route.

Each SDK-created root Agent receives the cap through `AgentOptions.maxTokens`. Agent Loop places that value in the initial `LlmCallConfig`; final call preparation preserves the explicit value or materializes an exact-model adapter default, logs the effective cap in the request header, and reconstructs every dispatched conversation request from that durable header. Omitting the SDK option therefore allows the selected adapter or provider route default to apply.

In-process subagents inherit the parent's provider, model, and output cap. An explicit `SubagentStartRequest.agentOptions.maxTokens`, including one configured by `dsh-tool-subagent`, overrides the inherited value for that child and its descendants. `subagent-dsh-sdk` owns a separate runtime per run: request `maxTokens` overrides its optional instance default, and the resolved cap crosses that child runtime's SDK handshake.

Compaction, session-title generation, web search, and other auxiliary calls keep their independently owned output limits. `maxTokensAsSuccess` remains outcome mapping only: it does not set or alter the cap.

## Alternatives considered

**Set only an adapter environment variable.** A serializer-private fallback would be DeepSeek-adapter-specific, invisible in the session request header, ineffective for intercepted or alternate adapters, and easy to confuse with a provider default. Adapter-owned defaults may instead be exposed as exact-model metadata and materialized into provider-neutral request configuration before logging.

**Add `maxTokens` to every `session/prompt`.** Per-turn mutation would enlarge the wire and introduce request-config transitions that callers do not need for the current evaluation use case. A runtime initialization option gives every session in one SDK process the same reproducible budget.

**Reuse `compaction-basic.maxTokens`.** The compaction value controls summary generation, not ordinary conversation requests. Sharing it would couple two different token budgets and make tuning one silently change the other.

## Consequences

SDK callers can bound model output without editing Cordis composition, and direct Agent creation uses the same validated `AgentOptions` contract. The cap is visible in durable request headers and reaches provider adapters as `GenerateOptions.maxTokens`; DeepSeek serialization maps it to `max_tokens`.

One SDK runtime has one default cap. A caller needing different caps runs separate runtime instances or uses a subagent provider that advertises `agentOptions`; DSH SDK naturally creates one such runtime per child run. Reaching the cap still produces the existing `max-tokens` stop reason, whose `ok` or `error` mapping remains deployment policy.
