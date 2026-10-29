# Agent Note: Composer image upload on add

Status: implemented

English | [中文](2026-10-21-composer-image-upload-on-add.zh.md)

## Problem

The Web composer kept image drafts in the browser and base64-encoded each image into `session/prompt` at send time, so the Host received, validated, normalized, and stored image bytes inside prompt admission. Generic files already uploaded when picked ([generic file upload](2026-08-26-generic-file-upload.md)). An image message therefore carried up to the per-message image byte limit in one RPC body, and its send time grew with image size; a composer that waits for the Host to accept a message before clearing it would hold the draft for that whole transfer.

## Decision

An ordinary Session's composer uploads each image draft as soon as it is added, through the same FIFO background-upload queue, Worker carriers, progress, retry, and cancellation that generic files use. The raw upload route takes a `mediaType` query parameter for an image upload; the Host reads at most the smaller of the deployment's per-image and per-message image byte limits, then validates, normalizes, and stores the image with `ctx.attachments.saveImages` exactly as prompt admission would, and stages the normalized image under a receipt for that Session. The prompt cites the receipt in an ordinary file part, so `session/prompt` keeps its wire types; prompt admission resolves the receipt to the stored image, applies the model's image-input check to the prompt, and counts stored images toward `maxImagesPerMessage` and `maxMessageImageBytes` together with encoded ones, each stored image by the bytes of its upload. Send waits until every image draft has a receipt, and a failed image upload turns its thumbnail into a retry control. Commands accept only file receipts, so command submissions keep encoding images inline. A continuable subagent's composer keeps inline images because the Host stages uploads only for ordinary Sessions; SDK and other wire callers may still send encoded images.

## Alternatives considered

- **A dedicated image-receipt prompt part.** Rejected: the receipt already names what was staged, so a second part kind would widen the `session/prompt` wire union, its generated catalogs, and every consumer that switches on parts without changing what the Host admits.
- **A separate image upload route or Remote method.** Rejected: one route with an explicit `mediaType` parameter reuses Session addressing, carrier selection, progress, and the failure envelope; the exact-bytes Remote fallback has no image caller.
- **Upload images but normalize them at send.** Rejected: normalization is the expensive part of image admission, so deferring it would keep the send-time cost this change removes.

## Consequences

- Sending an image message transfers only references, and the normalization cost moves to the moment the image is added.
- Per-image refusals such as an undecodable or oversized image surface when the image is added: the thumbnail names the refusal instead of offering a retry, and Enter repeats it. The model's image-input check and the per-message image count and byte limits still apply at send.
- Commands accept only file receipts, so a command submission that carries an image waits for the image upload like a message and then encodes the image inline: the image is stored a second time, and its unused receipt lasts until its Session ends.
- Removing an image while it uploads cancels the upload, and a cancelled upload receives no receipt; an image whose storage had already begun, or whose upload had finished, stays under `DSH_HOME`, which never deletes attachments. On a remote Host the bytes reach the server as soon as the user adds the image.
- Staged image receipts share the generic files' in-memory lifetime: a Host restart between adding and sending surfaces `FILE_NOT_STAGED`, and the user adds the image again.
- Image drafts, like file drafts, are not restored after a page reload or after their Session's client scope is released.

## Testing

Host coverage pins image staging through the raw route, the per-image byte bound that stops reading, unsupported types, subagent refusal, command refusal of image receipts, receipt resolution into the admitted image, the image-input check for an uploaded image, the per-message byte limit across receipts, and withheld receipts for uploads cancelled after their last chunk or during storage. Attachment admission coverage pins stored-image pass-through and the combined image count and byte limits. Client coverage pins image upload start, retry, cancellation, the send gate, receipt citation without re-encoding, inline images for drafts without an upload, the rail's progress, retry, and refusal states, and the Enter explanation of a held send.

## Related

The [generic file upload](2026-08-26-generic-file-upload.md) note owns the background-upload queue, carriers, staging lifetime, and file storage that image uploads reuse.
