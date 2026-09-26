# Agent Note: Replay malformed historical tool input through Messages

Status: implemented

English | [中文](2026-09-16-messages-historical-tool-input.zh.md)

## Problem

Chat Completions retains tool arguments as strings, including malformed JSON from failed calls. Switching that history to Messages requires an object for each `tool_use.input`. Rejecting one historical argument blocks every later request containing it, even after a successful tool retry; a summarization request containing the same call also fails.

## Decision

The [Messages serializer](../../../../packages/llm/llm-deepseek/src/serialize.ts) follows the [pi-ai history conversion](../../../../packages/llm/llm-pi-ai/src/replay.ts): malformed JSON and non-object values become `{}` only in the outgoing historical tool input. Call ids, names, results, and original Session records remain intact. This applies with valid, absent, or unusable native replay metadata and does not execute the historical call again.

This supersedes the historical argument rejection in the [Messages adapter decision](../feature/2026-09-07-deepseek-messages-adapter.md). New Messages responses still require valid object arguments before successful completion; output-limit truncation retains its existing pruning behavior. No Session event, persistence type, or protocol configuration changes.

## Alternatives considered

**Reject malformed history.** A failed call can remain relevant evidence without preventing all subsequent model requests.

**Repair or overwrite stored arguments.** Guessing missing quotes or retaining a parsed prefix can change the requested operation. Request-only empty input preserves the original evidence and requires no migration.

**Drop the call.** Its result still cites the call id; keeping both preserves the tool exchange without inventing arguments.

## Consequences

Messages continuation can omit unusable historical parameters without losing the call identity or result. The model sees `{}` rather than the original malformed text, and the fallback is silent, matching pi-ai. Original arguments remain available in the Session log; this does not claim lossless provider input or repair invalid newly generated calls.

Verification covers object-only conversion, failed results followed by user input, JSON round trips, both valid and degraded replay metadata, a [recorded Session](../../../../snapshots/session/deepseek-messages-invalid-tool-history/snapshot.yml) through the shipped headless profile and real Messages serializer, and a credential-gated live Messages continuation.
