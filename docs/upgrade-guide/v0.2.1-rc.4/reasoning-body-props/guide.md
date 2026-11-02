---
kind: upgrade-guide
description: "Reasoning Body Slot text carries display-ready content, with original output in rawText."
---

# Reasoning Body Slot text fields

English | [中文](guide.zh.md)

## Change

Contributions to `conversation.chat.reasoning.body` receive the model output in the new `rawText` field. The existing `text` field supplies Chat's prepared display text instead of the original output. `running` is unchanged. This affects custom reasoning renderers and translation wrappers.

The `conversation.chat.reasoning.content` Factory still accepts `text`, `running`, and optional `labels`. It renders the caller-selected Markdown. The [Chat README](../../../../packages/client/ui-chat/README.md#grouped-rendering) documents the Slot.

## Migration

1. Keep reading `text` for ordinary rendering, translation requests, and untranslated views. Update extensions that need the full model output to read `rawText`.
2. Pass the selected `text`, or its translation, to the Content Factory without repeating Chat's display processing.
3. Rebuild the extension and verify streamed and settled rendering, translation, and the untranslated view with each supported model format.
