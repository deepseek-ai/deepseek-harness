---
description: "Attachment presentation for the conversation UI: draft-image rail, document drop target, history-image gallery, and original-image lightbox; for users and maintainers of the Web attachment experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-attachment

English | [中文](README.zh.md)

## Summary

This package renders everything the conversation UI shows about attachments: pending draft images under the composer, a full-viewport drop invitation, durable images in Chat and Trajectory, and a lightbox for the original image. It is a pure presentation layer — attachment data, image loading, and callbacks come from the conversation package through declared slots. Choose it for the DeepSeek Chat-style image experience; non-image files have no surface here.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside [`ui-conversation`](../ui-conversation/README.md); it waits for the conversation package's slot declarations and registers its surfaces into them. Users then see the draft-image rail with per-image remove and click-to-open, the drop overlay with its limits line, message images sized by count, and the Escape/mask/close lightbox.

### Draft images

A draft image shows as a fixed 64px thumbnail in one horizontally scrolling row; edge arrows page the rail when overflow hides items, and the scrollbar stays hidden. A newly added item is revealed at the rail's end, removal keeps the scroll position, and a single click opens the original through the owner's `onOpen`.

### Message images and the lightbox

A message's lone image renders at 240px on its longer edge (aspect clamped to [0.25, 4], never upscaled); images among several render as fixed 64px squares. A loaded image opens the document-level lightbox on click; a failed load shows a retry control instead. The lightbox closes on Escape, a mask press, or its close control, and restores focus to its opener.

### Drop overlay

While a file drag is over the page, the full-viewport overlay announces the drop: illustration, title, and a limits line when drops are accepted. The overlay only shows state — the owner's document-level listeners decide accept or reject.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin waits for `conversation.input.attachments`, `conversation.message.images`, and `conversation.trajectory.images` through `ctx.slots.inject`. It then registers the composer rail, document drop target, shared history gallery for Chat and Trajectory, and original-image lightbox. The presentation components are pure props: the conversation slot owner supplies attachment data, image loading, callbacks, and the locale translator; the package entry exports no components.

| File | Role |
|---|---|
| [`src/client/ComposerAttachments.tsx`](src/client/ComposerAttachments.tsx) | Draft-image rail + drop overlay assembly |
| [`src/AttachmentRail.tsx`](src/AttachmentRail.tsx) | Scrolling thumbnail rail, wheel translation, edge arrows |
| [`src/client/MessageImages.tsx`](src/client/MessageImages.tsx) | Per-message gallery + lightbox assembly |
| [`src/MessageImage.tsx`](src/MessageImage.tsx) | Single image sizing, load/retry, click-to-open; local submission-echo previews render their object URL directly |
| [`src/ImageLightbox.tsx`](src/ImageLightbox.tsx) | Document-level modal preview over the shared mask |
| [`src/DropOverlay.tsx`](src/DropOverlay.tsx) | Pointer-inert drag invitation portal |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the attachment surface is not enough. They move from the slots this package fills to the conversation shell that owns the input flow.

- [ui-conversation](../ui-conversation/README.md) — declares the attachment slots and owns the composer and image intake.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only renders attachment state supplied by the conversation UI and contributes no model-visible input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current attachment surface. They are package constraints, not a general image-viewer comparison or a task backlog.

- **Images only** — non-image files have no rail card or history renderer yet; DeepSeek Chat-style file cards and upload progress wait until the composer accepts non-image attachments.
- **No zoom or download in the lightbox** — the preview renders the original at fit-to-viewport size only.
- **The lightbox does not trap focus** — it sets `aria-modal` and restores focus on close, but Tab can reach the page behind it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package contributes only effect-owned slot entries; the slot registry owns their lifecycle and validates their declarations.
