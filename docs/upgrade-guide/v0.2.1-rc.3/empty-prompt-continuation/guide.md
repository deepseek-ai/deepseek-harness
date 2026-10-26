---
kind: upgrade-guide
description: "Empty ordinary Agent inputs start requests without producing user/message events."
---
# Observe empty prompt admission through the inbox

English | [中文](guide.zh.md)

## Change

An ordinary Agent input with `content: []` starts a new turn from committed history without appending an empty `user/message`. The identified input remains in durable inbox events. Custom consumers that wait for every accepted input to produce a user message must observe its inbox receipt instead. Session logs need no migration; existing recorded empty user messages keep their historical interpretation.

The Web Session prompt endpoint accepts an empty array only for an eligible failed, idle ordinary Session in queue mode. Whitespace-only text parts remain invalid.

## Migration

1. Keep ordinary text and attachment inputs unchanged. Use an empty array only when requesting another model call without new user text.
2. Match acceptance by the input identity in `agent/inbox/spliced`, then observe the normal turn/status lifecycle. Do not wait for an empty `user/message`.
3. Verify that continuation adds a balanced turn without adding a user message. The shipped TypeScript and Python SDK clients already observe inbox receipts.
