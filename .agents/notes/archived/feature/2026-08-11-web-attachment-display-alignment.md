# Agent Note: Web attachment display aligns with DeepSeek Chat via attachment atoms

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-web-attachment-display-alignment.zh.md)

## Problem

The web composer's image surfaces missed basic usability (user feedback, issue #2248). The remove control hung outside each 72px thumbnail at `top/right: -6px`, so the rail's `overflow-x` box clipped it and clicks aimed at it often missed; previews opened only on double-click, an affordance nothing advertised except a tooltip; a rail wider than the composer produced a raw horizontal scrollbar inside the capsule; and image-intake rejections plus prompt failures (for example `attachment-error` when the selected model takes no image input) rendered as persistent inline red strips above the card. Every one of these surfaces already has a settled design in DeepSeek Chat that users know: single-click preview, an inside-the-card hover-revealed remove control, hidden-scrollbar arrow paging, and a transient top-center toast.

The first multimodal ship recorded these surfaces in the [web multimodal note](2026-07-22-web-multimodal-image-input-and-durable-attachments.md); this note supersedes its display and interaction specifics (thumbnail geometry, click affordance, error presentation) while its attachment seam, admission, and durability decisions stand.

All of this UI also lived inside `dsh-client-ui-conversation` — the rail inline in the 700-line `InputBar`, the history image and lightbox in `chat/` and `skeleton/` — with no seam that another surface could reuse and nothing enforcing the pure-props discipline the pieces already had.

## Decision

Attachment display lives in `@deepseek-ai/dsh-client-ui-attachment` (`packages/client/ui-attachment`): `AttachmentRail` (64px/16px-radius thumbnails, single-click `onOpen`, inside-the-card remove control revealed on hover or focus and permanent under `pointer: coarse`, hidden scrollbar with circular edge arrows recomputed from scroll geometry, vertical-wheel horizontal pan clamped to 60px/tick, end-reveal on growth), `MessageImage`/`ImageGallery` (single-click preview), and `ImageLightbox`. These remain internal pure-props components. `ui-conversation` declares the composer-attachment and message-image slots and supplies draft ids, image loading, intake callbacks, and its locale seat; the dynamic ui-attachment client entry waits on those declarations and registers the presentation. The [dynamic render and attachment ownership note](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.md) owns this package integration; the visual behavior recorded here is unchanged.

Both overlays body-portal: the lightbox opened from a chat message sits under transformed ancestors that would trap `position: fixed` in their own box (the backdrop covered only the chat column), so `ImageLightbox` and `Toast` render through `createPortal(document.body)` and cover the viewport from every opener. The transient banner is a `ui-primitives` `Toast` atom (120px from the viewport top, horizontally centered over its optional anchor — the composer card, so it sits over the chat column — `role="alert"`, `pointer-events: none`, three-second hold then one-second fade, `onDone` unmount, keyed per show so identical repeated messages re-announce). `InputBar` routes both intake rejections (`addImages`'s returned reason) and `promptError` through it, replacing the inline strips, and `ModelSelect` routes rejected model selections through the same atom while its in-menu strip with Retry stays the catalog-load surface; the machine-notice strip is untouched. DeepSeek Chat's source (a local reference copy) provided the target behaviors: its `ImageThumbnailInInput` (64px cards, opacity-transition delete), `ScrollArrows` (sentinel-driven paging), and `useToast` usage.

## Alternatives considered

**Keep the components inside `ui-conversation` and only restyle.** Rejected by the user: the attachment surface is expected to grow (file cards, upload progress), and the repo's plugin discipline forbids other plugins importing `ui-conversation` internals, so growth inside the plugin builds an unreusable pile. The atoms package gives the same components a sanctioned import path.

**Export attachment atoms and import them directly from `ui-conversation`.** Rejected by the package integration decision: direct component imports bypass dynamic plugin lifecycle and cross-plugin slot composition. The conversation package still owns the data and render sites, while ui-attachment owns their optional presentation entries.

**Toast inside `ui-conversation`.** Rejected: nothing about a transient banner is conversation-specific, and `ui-primitives` is the established home for zero-cordis atoms other surfaces may reuse.

**Keep inline error strips and only add the toast for image intake.** Rejected: `promptError` (the `attachment-error` screenshot in the issue) is the surface users actually complained about, and two error presentations in one composer would leave the strip as the odd survivor.

## Consequences

The composer and history image surfaces match DeepSeek Chat's interaction model, and the pure-props components render under the conversation slot's locale seat without reaching into application state. The cost is a real dynamic package boundary: `ui-attachment` carries the standard plugin scaffolding (client bundle, invariant companion, bilingual README, tsconfig face, per-file 100% coverage), and omitting it leaves the two optional attachment slots empty. Error banners are transient — a user who looks away for four seconds misses the message, the trade DeepSeek Chat itself makes. Non-image attachments remain unsupported; the rail's card model is ready for them but the composer's intake is image-only (tracked in the package README's limitations).
