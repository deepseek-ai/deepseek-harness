---
kind: upgrade-guide
description: "Messages mock streams publish named SSE events for native SDK consumers."
---

# Read named events from the Messages mock server

English | [中文](guide.zh.md)

## Change

The next release makes `@deepseek-ai/dsh-llm-mock-server` emit the Messages event name beside each structured SSE payload. Native SDKs require these names to process message and content-block events. Consumers that accept only unnamed SSE messages must update their event handling. Scripted payloads, ordering, request capture, and chunk counts are unchanged; the deliberately malformed JSON behavior still sends its invalid data directly.

## Migration

1. Consume the named Messages events and parse their `data` fields. Do not filter the stream to unnamed events.
2. Verify a complete text response, tool-call response, and the fault behaviors your test uses. The [mock server reference](../../../../packages/test-support/llm-mock-server/README.md) describes the available scripts.
