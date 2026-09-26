# Agent Note: Replay assistant blocks in Messages user input

Status: implemented

English | [中文](2026-09-18-messages-input-history-compatibility.zh.md)

## Problem

Saved subagent settlement notices can contain child reasoning and tool calls in parent user messages. Chat Completions and pi-ai omit these blocks from user input, while rejecting them in Messages prevents every later request containing the same history. The [text-only settlement producer](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.md) prevents new notices from carrying these blocks but cannot repair already recorded messages.

## Decision

The [Messages serializer](../../../../packages/llm/llm-deepseek/src/serialize.ts) omits `reasoning` and `tool-call` blocks from user and tool-result input. This matches Chat Completions and pi-ai for these two block types, without changing Session records or converting child reasoning into parent user text. The [provider README](../../../../packages/llm/llm-deepseek/README.md#model-experience) owns the input rules, including empty user messages, empty tool results, and rejection of other unsupported blocks.

This partially supersedes the settlement decision's rejection of serializer tolerance and the [Messages adapter decision](../feature/2026-09-07-deepseek-messages-adapter.md)'s input rejection. Notice construction still projects nonempty child text for every parent provider. Canonical child output and ordinary assistant reasoning and tool calls remain available to their existing consumers. The omission is based on input role and block type, not the notice source or creation date, so it also applies to newly supplied user and tool-result content.

## Alternatives considered

**Fix only the producer.** New notices are representable, but saved notices still block protocol switching and continuation.

**Rewrite Session history or flatten reasoning into user text.** Rewriting removes original evidence; flattening sends child reasoning as parent input. Request-only omission preserves the durable record and existing input semantics.

**Ignore every unsupported block.** Unknown plugin content has no Messages representation defined here. Compatibility for two known assistant block types does not establish one.

**Move a system update to an earlier retained user turn.** When the corresponding user input is omitted, moving the update before an earlier assistant changes its position in the conversation and rewrites a previously sent prefix. The [documented in-history limitation](../../../../packages/llm/llm-deepseek/README.md#known-limitations-and-deferred-work) remains explicit rather than inventing a user message or relocating the update.

## Consequences

Saved notices with retained text can continue through Messages. The provider no longer diagnoses these two block types as user-input producer errors; the settlement producer remains responsible for text-only notices. This does not promise lossless provider input or compatibility for every historical message sequence.

Verification covers user and tool-result filtering, unchanged durable content, HTTP continuation, and a [headless Session replay](../../../../snapshots/session/deepseek-messages-input-history/snapshot.yml). Serialization tests pin rejection of an in-history update when its user input is entirely omitted, both before another assistant and at request end, and acceptance when text or a tool result retains the corresponding turn.
