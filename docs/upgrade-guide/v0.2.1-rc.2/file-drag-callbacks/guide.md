---
kind: upgrade-guide
description: "Custom image factories and Markdown image delegates must supply file preparation callbacks."
---

# Supply file preparation callbacks to image views

English | [中文](guide.zh.md)

## Change

The published `conversation.images.content` Factory now requires a `fileDrag` inject member, and `MarkdownDelegate.fileImages` requires the same callbacks. `ChatViewInjected` also gains `fileDrag`. Custom registrations that construct these values must update before compilation succeeds. The shipped Web and Desktop compositions provide `@deepseek-ai/dsh-client-ui-file-drag`; custom compositions must provide the service and its feedback slot. Existing image label fields are unchanged.

## Migration

1. Include `@deepseek-ai/dsh-client-ui-file-drag` in the custom client composition, together with locale, the slot renderer, and a shell declaring `shell.overlay`. Declare `fileDrag` in each consumer plugin’s `inject` list.
2. Pass `ctx.fileDrag.actions` as `fileDrag` when registering `conversation.images.content`, assembling `ChatViewInjected`, or constructing `MarkdownDelegate.fileImages`. The callbacks prepare Blob or URL content and report localized failures; components receive them explicitly. Optional `resourceAddress(path)` supplies a Session resource reference for authorized Desktop source reuse.
3. Custom composer implementations can receive `ctx.fileDrag.read` through their own inject interface to accept application-local tokens. The `conversation.input.attachments` slot’s public props remain unchanged; only the shipped attachment implementation requires this callback. Accept internal drops in the composer region and retain ordinary `dataTransfer.files` handling for external files.
4. Rebuild custom packages and verify an image drag into the composer. Confirm the original filename and bytes and that dropping back on the source does not add an attachment. See the [file-drag plugin](../../../../packages/client/ui-file-drag/README.md) for ownership and browser limitations.
