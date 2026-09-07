# Agent Note: Trajectory durable image attachments

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-24-trajectory-image-attachments.zh.md)

## Problem

Trajectory did not display session images. A durable `{ type: 'image', attachment: ImageAttachmentRef }` block rendered as pretty-printed JSON in the details panel, and an image-only user message produced an empty ledger row. The only image path Trajectory knew was `imageSrc` sniffing over inline wire fields (`url`, `image_url`, base64 `data`), which no production event carries: every producer commits a durable `ImageAttachmentRef` before its event is appended. Users could not confirm from the execution ledger which image the model saw ([issue #2986](https://github.com/deepseek-harness/deepseek-harness/issues/2986)), while Chat already displayed the same attachments.

## Decision

- `ui-conversation` owns the per-session durable image URL cache. `HistoricalImageCache` moved from `ui-chat` into `packages/client/ui-conversation/src/client/conversation/historical-images.ts` and is served as `ctx.uiConversation.imageUrl(sessionId, attachment)`. Chat and Trajectory resolve through the same instance, so one session attachment costs one `session.attachment` read and one browser URL, revoked when the Session binding is released. This partially supersedes the `ui-chat` cache ownership recorded in [client Session/Conversation ownership](../architecture/2026-08-20-client-session-conversation-ownership.md).
- The gallery owner contract (`MessageImagesOwnerProps`, `RenderMessageImages`) moved to the `ui-conversation` client contract. `ui-chat` keeps its `conversation.message.images` SlotMap row over the shared owner type; `ui-trajectory` declares its own child slot `conversation.trajectory.images` with the same owner type; `ui-attachment` registers the one `MessageImages` gallery component into both keys, so loading, retry, and lightbox behavior is identical in both views.
- `TrajectorySourceBlock` carries `attachment?: ImageAttachmentRef` instead of `imageSrc`/`imageAlt`. The inline-source sniffing (`sourceImage`, `safeImageSource`) and the Trajectory-local `PanelImage` renderer are removed: no producer writes inline image bytes or URLs into the session log, so those paths were dead code, and the issue explicitly excludes upload-time transient paths.
- A record whose content has images but no text labels its ledger row with the locale-owned `layout.imageOnly` count; tool results with only images use the same label for their result summary instead of a JSON dump.
- Neither the storage nor the BFF changes: `session.attachment` already authorizes by session-log reference (missing, corrupt, and unreferenced attachments fail loud into the gallery's retry state), and sha256 content addressing already stores each image once.

## Alternatives considered

**Keep Trajectory's own `<img>` rendering and feed it resolved URLs.** This duplicates the loading placeholder, retry control, and lightbox that `ui-attachment` already owns, and contradicts [slot-based attachment ownership](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.md), which rejected cross-plugin component imports.

**Lift the `conversation.message.images` declaration to a shared parent so both views render one key.** `renderSlot` is typed to the declaring entry's own children table, so a sibling `conversation.view` entry cannot render another entry's child key; the slot registry also rejects a second declaration of the same key. A second key sharing the owner type is the supported composition and lets a theme replace either gallery independently.

**Keep the inline `imageSrc` sniffing beside the durable path.** All producers (host prompt admission, `read_image`, MCP projection, ACP ingress) commit durable refs before their events append, so the sniffing matched nothing; keeping it would preserve a non-durable rendering path the acceptance criteria exclude.

**A Trajectory-owned image cache.** A second cache per view issues duplicate `session.attachment` RPCs and duplicate blob URLs for the same session attachment, violating the "Chat and Trajectory reference the same session attachment" requirement for no benefit.

## Consequences

- Both views present one gallery implementation, so image behavior (sizing, retry, lightbox, labels) cannot drift between Chat and Trajectory, and a session attachment is read once regardless of how many views show it.
- `TrajectoryTable` threads a required `renderImages` prop through its detail components; `ui-trajectory` gains a type-only dependency on `dsh-attachment`, and `ui-attachment` gains a type-only dependency on `ui-trajectory` for the new SlotMap row.
- The keyless assembled snapshot `apps/web/tests/trajectory-image-display.snapshot.ts` pins the shared-cache fact directly: the details-panel image URL is string-identical to the Chat gallery's URL for the same fixture attachment.
