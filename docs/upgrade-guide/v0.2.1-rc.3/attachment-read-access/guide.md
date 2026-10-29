---
kind: upgrade-guide
description: "Image read requests require a complete attachment reference and no longer check Session membership."
---

# Image read requests carry the complete attachment reference

English | [中文](guide.zh.md)

## Change

In 0.2.1-rc.3, `session/attachment` accepted `{ sessionId, attachmentId }` and searched the requested Session's history for the complete image reference. It now requires `{ sessionId, attachment: ref }`, where `ref` is an `ImageAttachmentRef` containing `attachmentId`, `mediaType`, `bytes`, `width`, and `height`. The Client's `session.readAttachment()` also takes the complete reference instead of an ID.

The Host passes this reference to the existing `AttachmentStore.readImage(ref)`. It verifies the ID, actual format, byte length, width, and height against the stored object. The response remains `{ attachment, data }`, with base64 bytes in `data`. It preserves the supplied reference, including optional `name` and `originalDimensions`; those two fields are caller-supplied display information and are not verified against the file. Missing, corrupt, and mismatched objects fail explicitly.

Connection authentication and Gateway permission checks still apply. Any identity authorized to call the endpoint for the supplied `sessionId` may read an image in the same store, including one referenced only by another Session or by no Session. The handler does not check image membership or Session existence and no longer returns `session/not-found` for an absent Session after authorization.

## Migration

1. Update wire calls from `{ sessionId, attachmentId: ref.attachmentId }` to `{ sessionId, attachment: ref }`, using the complete reference from the message image block. Update Client calls from `session.readAttachment(ref.attachmentId)` to `session.readAttachment(ref)`.
2. Treat returned `name` and `originalDimensions` as the caller's display information. Only the ID, media type, byte length, width, and height are checked against the stored object.
3. If your deployment depends on Session membership to isolate images, run separate Host instances with separate `DSH_HOME` directories before upgrading. The shipped composition does not select separate stores by Session within one Host. Gateway permissions govern endpoint invocation, not the image's Session membership.
4. Confirm that an allowed request with a complete reference can read an image absent from the supplied Session, including when that Session does not exist. Denied Gateway requests, missing images, and references with mismatched intrinsic metadata must fail. Existing Session logs and stored images need no migration.
