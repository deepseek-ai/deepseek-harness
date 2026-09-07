# Agent Note: Whole-page image drop, projected intake limits, and thumbnail tiling

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-web-image-intake-and-limits-alignment.zh.md)

## Problem

The second alignment step for issue #2248, after the [attachment display note](2026-08-11-web-attachment-display-alignment.md) (whose rail/toast/atoms decisions stand; this note supersedes its history-gallery geometry and the lightbox backdrop specifics). Remaining gaps against DeepSeek Chat: images could only be dropped on the composer card — a drop over the transcript navigated the browser away to the file; the lightbox close glyph was a bare `×` text character (buttons inherit no font family and the glyph's ink sits above the line box center, so it rendered visibly off-center) over a `color-mix(label-primary 74%)` backdrop that inverts to a bright white wash in dark mode; a message's images stacked vertically as up-to-240px blocks because the gallery container itself was pinned to 240px; and nothing client-side enforced or displayed the image limits — a user could stack 50 images and learn about `maxImagesPerMessage` only from a raw `attachment-error (TOO_MANY_IMAGES)` toast after submit, watching the rail empty and refill around the failure.

## Decision

**Whole-page drop.** InputBar binds `dragenter`/`dragover`/`dragleave`/`drop` on the document (enter/leave depth counting, viewport-edge and `dragend` resets, `Files`-type gating so text drags keep their native textarea path) and renders the new `DropOverlay` atom in `ui-attachment`: a body-portaled, pointer-inert full-viewport layer (DeepSeek Chat's DragMask visuals — white/70% + 10px blur, dark `rgba(39,39,48,0.7)`, illustration, title, limits line) whose `disabled` variant announces a locked/busy composer. Pointer-inertness is load-bearing: drag events keep targeting the page below, so the depth count never sees the overlay itself. Document-level listener state is safe because the composer-bar slot is `kind: 'single'`.

**Lightbox.** The close control is `ui-primitives`' `IconCloseOutline16` (the Modal precedent — an SVG centered in its viewBox needs no font metrics). The backdrop is the shared dialog mask (`--dsw-alias-bg-mask-1` + `--dsw-mask-blur`, black-based in both themes) painted on a separate sibling layer, because `backdrop-filter` on the container would blur the previewed image itself.

**History thumbnails (DeepSeek Chat rules).** A message's lone image renders at 240px on its long edge with the displayed ratio clamped to [0.25, 4], cropped by `cover` with the anchor at the top of very tall images and the left of very wide ones, never upscaled; several images render as fixed 64px square tiles in one wrapping row (10px gap, user messages right-aligned). Consecutive assistant `image` blocks merge into one gallery so they tile instead of each opening a one-image row.

**Limits aligned and projected.** Intake defaults are 20 images, 32 MiB per source, 100 MiB aggregate source bytes, 100 million decoded pixels, and 16384px per source side. The attachment backend prepares a separate durable master with a 2048px long edge and 4 MiB safety cap. Model requests have their own route-specific pixel and encoded-byte budgets, so source admission does not use provider request limits. The HTTP carrier uses one shared `DEFAULT_MAX_REQUEST_BODY_BYTES = 160 MiB` to satisfy the load-time capacity assertion for the 100 MiB aggregate after base64 and envelope expansion. A 512 MiB aggregate cannot pass this transport because base64-in-JSON would require a JSON string near V8's string-size limit. The intake limits reach clients as the `imageLimits` session projection, a constant-per-boot unit registered by **apiproxy** rather than the attachment Service Definition. `dsh-llm` depends on `dsh-attachment`, while `dsh-session-projection` reaches `dsh-llm` through `dsh-session`; registering the projection in the seam package would create a project-reference cycle. The per-message count and aggregate rules are also enforced by the proxy. The `SessionProjectionMap` merge remains in the proxy sessions wire file, which clients already consume through carrier type re-exports.

**Intake pre-check and error copy.** Both intake gestures converge on one `intakeImages` wrapper in InputBar that checks count, per-image bytes, and aggregate bytes against the projection before `addImages`: a violating batch is refused whole (DeepSeek Chat semantics) with an immediate banner naming the limit — no submit-time rollback theater. The host checks stay as the backstop for callers that bypass the composer. Banner copy follows one principle the user set: reasons a user can act on (model without vision, count, size, resolution, format — now a positive list of supported formats instead of echoing the rejected MIME type) get product sentences naming the way out; reasons they cannot act on (corrupt base64, lost references, read failures) fold into one send-failed sentence that keeps the reason code, because the product currently faces developers and a reportable code beats a dead end. Non-attachment error codes keep the raw message + code presentation.

## Alternatives considered

**Registering the projection unit in the attachment Service Definition's constructor.** The natural seam owner, and the first implementation — rejected by the dependency graph (the cycle above) and by a test-harness interaction: the base constructor calling `ctx.inject` made directly-constructed stores in specs trigger the global invariant host, which then double-mounted an `attachments` service into the same root.

**`--dsw-alias-bg-mask-photo` (0.88 black, theme-stable, unused) for the lightbox.** The design system's photo-viewer token and dsweb's likely lightbox wash; the user chose consistency with the settings dialog mask (`bg-mask-1` + blur) — both fix the dark-mode inversion.

**Pre-checking inside `apply.ts`'s `addImages` inject.** The seam-purist placement, rejected for plumbing cost: the projection store has no non-React face exposed to the inject factory, while InputBar already consumes projections idiomatically and is the single caller of both gestures.

**A `host.describe` field instead of a projection.** Session-independent and cheaper, but delivered through an injected prop chain rather than `useProjection`, and the projection's key-absence semantics ("no attachment service composed → no pre-check") fall out for free.

## Consequences

A drop anywhere on the window now lands in the rail, over-limit intake fails at the moment of the gesture with copy naming the limit, and history images tile like DeepSeek Chat's. The carrier's default request-body budget is ~5× larger and remains a per-request resident-memory bound (the bridge buffers bodies whole; recorded in the connection README's limitations). The fixture transport mirrors the projection with hardcoded default numbers — a deployment that overrides the limits diverges from fixture-mode copy, acceptable for a keyless demo lane. Gallery arrow navigation, lightbox zoom/download, and non-image file cards remain deferred (#2248).
