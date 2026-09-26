# Agent Note: Consistent Trajectory attachment presentation

Status: implemented

English | [中文](2026-09-15-trajectory-attachment-presentation.zh.md)

## Problem

A user message can contain text, images, and ordinary files. Trajectory omitted image counts beside text, left ordinary files out of Preview, and mixed file JSON with rendered images in Raw. Readers could not identify the complete attachment set consistently across the ledger and inspector (Issue #4356).

## Decision

Trajectory presents every attachment occurrence while keeping visual inspection separate from inspection of recorded fields.

| Location | Behavior |
|---|---|
| Ledger | Separate nonzero image and ordinary-file counts accompany the text excerpt, including messages without text. Each record stays on one compact line. |
| Summary and Preview | Message text precedes one ordered attachment list. Both tabs use the same renderer; Summary retains its compact spacing and scroll container. |
| Attachment list | Equal-width compact rows share spacing and corners. A file-type icon or contained image thumbnail accompanies the recorded name and available metadata. Repeated references retain their occurrence order. |
| Image interaction | The complete image fits inside a 48px square thumbnail without cropping. Activation opens the existing image viewer, with keyboard access. Loading and retry icons fit the thumbnail and expose localized tooltips and accessible names. |
| Raw | Image and file blocks use initially collapsed metadata disclosures with complete recorded fields. Original content-block order and unrendered text remain intact; generated display labels do not enter raw fields. |

Recorded filenames take precedence over localized numbered image labels. Metadata comes from recorded fields or the filename extension; zero-byte sizes remain visible. Visually truncated names retain their complete accessible text and tooltip. Messages without text still expose all attachments inside the inspector's scroll area.

### Ownership

[ui-trajectory](../../../../packages/client/ui-trajectory/README.md) owns counts, ordered attachment projection, and inspector composition. Its view data carries typed image and file references separately from the serialized content used by Raw, so display code does not recover file metadata by parsing JSON.

[ui-attachment](../../../../packages/client/ui-attachment/README.md) owns image loading and the viewer through the existing image slot. [ui-conversation](../../../../packages/client/ui-conversation/README.md) owns the per-session image cache: Chat and Trajectory share one authorized read and browser URL per attachment. Thumbnail sizing and optional display labels affect presentation only; loading still receives the original reference. Chat and tool-result gallery sizing retain their existing behavior.

This decision uses existing durable attachment references without changing upload, storage, model requests, or the Session format. Ordinary files expose metadata without a content viewer or download action. Product labels use typed locale dictionaries, and styles use the existing semantic tokens.

The [generic file upload decision](../feature/2026-08-26-generic-file-upload.md) owns upload, storage, admission, and ordered message attachments; this record owns Trajectory presentation. The [unreadable attachment quarantine proposal](../../proposed/bug-fix/2026-08-20-attachment-read-quarantine.md) concerns model-request recovery independently of thumbnail loading feedback.

## Alternatives considered

**Keep large inline images as the default inspector presentation.** This makes one image immediately readable, but a tall image displaces attachment names and message text in the narrow inspector. Compact rows with explicit image activation provide a consistent overview of mixed attachments.

**Use two-column attachment cards.** A grid can make thumbnails more prominent on wide panels, but it leaves less room for long filenames and requires a different narrow-panel arrangement. A single equal-width list accommodates both panel widths.

**Keep file JSON and image previews together in Raw.** This assigns different meanings to the same tab for two attachment kinds. Metadata disclosures let readers inspect recorded fields while Preview owns visual image presentation.

## Consequences

The shared attachment renderer keeps names, order, metadata, and image actions consistent between Summary and Preview. Grouping attachments after message text makes the complete set easy to scan; Raw preserves interleaving when readers need the original block sequence. Repeated references remain separate rows even when image loading shares a cache entry.

Compact thumbnails require opening the viewer to read detailed diagrams. Missing metadata stays absent, and image-read failures retain a retry control without hiding ordinary files. Changes to the shared image slot also affect Chat and tool results, so their gallery behavior and cache reuse remain regression requirements.

## Verification

[Projection tests](../../../../packages/client/ui-trajectory/tests/layout.client.spec.tsx) cover mixed, attachment-only, empty-text, and repeated occurrences. [Inspector tests](../../../../packages/client/ui-trajectory/tests/table.client.spec.tsx) cover both locales, unnamed images, long filenames, zero-byte files, ordered lists, and complete Raw fields. [Image tests](../../../../packages/client/ui-attachment/tests/message-image.client.spec.tsx) cover thumbnail labels, loading, retry, and the existing viewer.

The recorded [mixed-upload browser scenario](../../../../apps/web/tests/file-upload-round.e2e.ts) compares Summary and Preview, verifies keyboard activation and focus restoration, checks collapsed and expanded Raw content, and repeats inspection after reload. Its [Trajectory expectation](../../../../snapshots/web/file-upload-round/trajectory.expected.md) accompanies the unchanged Session fixture. The [assembled image-cache test](../../../../apps/web/tests/trajectory-image-display.expected.e2e.ts) also checks reuse between Chat and Trajectory.

Layout acceptance covers narrow and wide panels, both themes and locales, complete thumbnail containment, and reachable final attachments. The [GIF workflow](../../../skills/record-browser-gif/SKILL.md) requires review evidence from a clean committed tree and one real-server, real-model session showing mixed submission, ledger counts, Summary, Preview image activation, and expanded Raw metadata. Issue #4356 and its linked PR track executed checks and demonstration evidence.
