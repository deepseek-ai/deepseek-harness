---
kind: upgrade-guide
description: "AttachmentError now extends HarnessError, so tool and model-request failures record attachment codes instead of losing them or reporting UNKNOWN."
---

# Attachment failures keep their codes

English | [中文](guide.zh.md)

## Change

`AttachmentError` from `@deepseek-ai/dsh-attachment` now extends `HarnessError` from `@deepseek-ai/dsh-error`. Its `name` (`AttachmentError`) and every `ATTACHMENT_*` and image admission code are unchanged. Two persisted results change:

- When a model request fails because an adapter could not read an image attachment, the failed turn's `turn/end` error previously recorded `code: 'UNKNOWN'`. It now records the `AttachmentError` code, such as `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_CORRUPT`, `ATTACHMENT_READ_FAILED`, or an image admission code such as `INVALID_IMAGE` or `IMAGE_TOO_LARGE`.
- A tool whose body lets an `AttachmentError` escape now records `error: { name: 'AttachmentError', code }` on its `tool/result`; previously the result had no `error`. `read_image` also records the `AttachmentError` code and names the file and the next step in the message.

`instanceof HarnessError` now matches `AttachmentError`. `isAttachmentError` is unchanged.

## Migration

1. If analytics or retry rules treat `UNKNOWN` model failures as a catch-all, add the codes of the exported `AttachmentErrorCode` type; in code, identify these failures with `isAttachmentError`. The codes do not share one prefix.
2. If code catches `HarnessError` before `AttachmentError`, move the `AttachmentError` check first wherever the two need different handling.
3. Earlier Session logs keep `UNKNOWN`; readers that compare old and new logs should treat both as the same failure class for attachment reads.
