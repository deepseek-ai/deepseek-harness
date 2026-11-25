---
kind: upgrade-guide
description: "Conversation View focus is now a value tagged by kind, and View Definitions list accepted kinds instead of translating ids."
---

# Conversation View focus values

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, `ConversationViewRequest.focus` was a string that each View Definition produced through `toolCallFocus(callId)`. After upgrading, `focus` is a `ConversationFocus` value tagged by `kind`, such as `{ kind: 'tool-call', callId }` or `{ kind: 'request', turn, step }`. A View Definition lists the kinds it handles in `accepts`, and `openView(view, focus)` takes the same value. A pending request saved by an earlier build is discarded when the Session is restored. See [View selection](../../../subsystems/conversation.md) for the shell rules.

## Migration

1. In a third-party View Definition, replace `toolCallFocus: callId => …` with `accepts: ['tool-call']`, and add `'request'` when the View can reveal a model request.
2. In the View component, read `viewRequest.focus.kind` and take `callId`, or `turn` and `step`, from the value instead of parsing a string. Ignore kinds the View does not handle.
3. Change direct `openView(view, 'id')` calls to `openView(view, { kind: 'tool-call', callId: 'id' })`.
4. To add a new kind, extend `ConversationFocusMap` by declaration merging with JSON-serializable fields, list it in `accepts`, and confirm the plugin type-checks.
