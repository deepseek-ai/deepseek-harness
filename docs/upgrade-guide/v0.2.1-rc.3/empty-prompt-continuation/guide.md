---
kind: upgrade-guide
description: Empty API and SDK prompts become retry controls whose required Session event needs an updated reader.
---

# Empty prompts and retry controls

English | [中文](guide.zh.md)

## Change

The Session prompt API accepts `content: []` to continue eligible failed, idle sessions in queue mode. SDK `session/prompt` maps empty `contentBlocks` to the same retry-source control. Acceptance records `agent/retry` with `turn`, `step`, `inputId`, and `source`, instead of a `user/message`. A new turn still starts and closes normally. Direct Agent callers using ordinary empty user messages retain their existing behavior.

The new required event and retry source keep the current Session format version. Updated readers accept older logs; older readers reject logs containing the unknown required event. See the [persistence acknowledgement](../../../persistence-changes/2026-10-27-retry-control-input.md).

## Migration

1. Upgrade Session readers and SDK runtimes together before opening logs containing retry controls.
2. Consumers correlating empty API or SDK prompts with `user/message` must use the durable inbox identity and `agent/retry.inputId`. Handle the retry source without treating it as model-visible user content.
3. Verify that a continued failure produces a balanced new turn and `agent/retry`, while derived model history contains no additional user message.
