# Agent Note: Tool-card image results

Status: implemented

English | [中文](2026-08-20-tool-card-image-results.zh.md)

## Problem

A settled `read_image` call rendered its raw attachment object as literal text in the tool card — `{"type":"image","attachment":{"attachmentId":"sha256:…","mediaType":"image/png","bytes":24588,"width":1496,…}}` — instead of showing the image.

Two independent gaps produced that. `read_image` declared no `output.presentationMeta`, so no presentation metadata told a client card how to present the reference — the tool card printed the raw result content as text. Separately, the tool-card layer had no image concept: `packages/client/ui-tool/src` contained no occurrence of `image` or `attachment`, and `ToolRow`'s card slots were terminal, diff, read, search, and web.

The rendering capability already existed, but only on the message path. `MessageImages` draws durable image groups for user and assistant history through the `conversation.message.images` slot. That asymmetry explains a confusing observation: a **nested** `read_image` displayed correctly, because `execute` defers a real user message for a nested call, while a top-level call — which returns the image only as tool-result content — did not.

## Decision

**Host.** `read_image` gains an `output.presentationMeta` that persists `{ path }` — the path only.

The attachment reference is deliberately not persisted there. The settled `content` already carries the image block with the complete reference, and that block is what a `tools/post-execute` hook replaces when it legitimately rewrites a result. A second copy in `meta` would therefore be a duplicate record of one fact, and a stale one exactly when the content changed — the card would keep showing an image the result no longer returns. The path is the one fact the content does not carry as a structured field: the model-facing envelope embeds the backend-resolved path as text, and the client never parses that text.

No `presentResult`, and no new member of the closed `ToolResultView` union. Client cards derive from raw event fields, and host `presentCall`/`presentResult` values never enter the client ([ui-tool README](../../../../packages/client/ui-tool/README.md)), so a result-view arm would have been a public type extension with no consumer.

**Client.** `imageCardModel` derives the card the way every other first-party card does: `parsedToolCall` validates the call head and its `file_path`, `block.meta` supplies the path — a nested call (a `read_image` dispatched from inside `run_code`) persists no `meta`, so the call's own `file_path` argument fills the label — the attachment reference is narrowed out of the result's own image block, and the envelope is located in the same content. It matches its own envelope by shape rather than using `singleResultText`, because that helper accepts only a lone text block while an image read returns `[text envelope, image block]` — matching by shape also means content another layer prepended is never mistaken for the envelope.

The narrowing checks the attachment id for existence only. The id is opaque and provider-owned: the local store mints content addresses, but consumers must neither parse that representation nor assume its shape, and a provider may change it without notice. Pattern-matching the local form would reject a legitimate id from an alternative store and silently degrade every image card in that deployment.

`ToolRow` gains an `image` card slot, and `read_image` gets a keyed toolview that declares the Tool-owned `tool.call.images` slot as its child and renders the gallery through it. The tool layer never loads or authorizes anything: the row supplies only the references it derived from the result plus the `loadImage` loader the chat node now passes down (`ChatNodeOwnerProps.loadImage`), and the attachment presentation plugin fills the slot with the same gallery it uses for message images. An image-bearing tool therefore registers a keyed toolview (`read_image` is the template for the row assembly and card model; the `tool.call.images` child declaration is not reusable verbatim, because a slot is declared by exactly one entry); the generic fallback keeps its flattened text.

The card keeps the derived envelope text below the gallery. That is not redundancy: `tool.call.images` renders nothing in a deployment without the attachment presentation plugin, and that empty gallery must not leave a blank card — measured, not assumed: a slot returning `null` rendered an empty container with no visible text.

`read_image` joins the `read` variant and gets its own locale title key. Left unclassified it fell to `others`, which titles the row generically and derives no `filePath` (only read/write/edit variants do), so the openable path the row advertises would never have been openable.

`read` and `read_image` are the same single-file card row with different card material, so their shared assembly lives in `read-family-row.tsx` rather than being copied.

## Alternatives considered

- **Add `card: 'image'` arm to `ToolResultView` and a `presentResult`.** This is what the first version did. Client cards derive from raw events and host presentation values never reach the client, so the arm had no consumer — an extension of a closed public union that nothing read. Dropped in favour of `presentationMeta` alone.
- **Pass a rendering closure down (the `renderMessageImages` pattern).** The next version reused `ChatNodeOwnerProps.renderMessageImages` as a `renderImages` owner prop, mirroring what `AssistantMarkdown` and the message rows do. Review rejected it: the client rule forbids new ReactNode-valued owner props, and the compliant shape is a slot the tool layer itself declares. With `loadImage` down-threaded from the chat node, the row renders `tool.call.images` directly and no rendering capability crosses the owner boundary.
- **Render the image on the generic fallback too.** The slot design cannot: a slot is declared by exactly one entry, and the fallback component is not a registered entry, so it has no dispatch seat for a child it did not declare. The keyed row is the only image render site; future image tools register their own.
- **Use `singleResultText` like the read card.** It accepts only a lone text block by design, and an image read returns two, so the card matches its own envelope shape instead.
- **Persist the reference in `meta` as well.** The first version did, and it read the card from there. Review pointed out the duplication, and the recorded log confirmed it: `meta.image` and the content block's `attachment` were byte-identical. Reading from the content instead leaves one record and follows a post-execute replacement.
- **Validate the attachment id against `sha256:<hex>`.** Tried, then reverted: it contradicts the documented opacity of `AttachmentId` and would break any deployment whose store mints another shape.
- **Give the image card its own primitive in `ui-primitives`.** Rejected as duplication — the message gallery's fit rules, crop anchors, and lightbox are the behavior a card needs.

## Verification

`read-image.spec.ts` covers the metadata projection, the omitted display name, and a real execution whose persisted reference matches what the attachment store committed. `image-card.client.spec.tsx` covers the derivation from metadata and envelope, path relativization, opaque ids from alternative stores, every rejection branch of the defensive narrowing, the running/error declines, the nested-call derivation with its argument-path fallback, the keyed row render site dispatching `tool.call.images` with the loader, keyed registration with the child-slot declaration, and the empty-slot fallback.

Negative controls were run against each assertion group before it was kept: removing the variant classification, disabling the image render branch, mistyping the registrant key, restoring the `sha256:` id pattern, and pointing the card's text back at the row's flattened output each turned the intended assertion red.

## Consequences

A `read_image` result now renders as the image on the tool card for both a top-level call and a nested one (a call dispatched from inside `run_code`), and the tool card gains an image kind. A nested call already displayed its image on the message path — `execute` defers a real user message for it — but its own tool row stayed generic; the card derivation now covers it too, with the call's `file_path` argument standing in for the persisted path. The image kind is not automatic from the metadata alone: the card also requires the `tool.call.images` slot to be filled (the attachment presentation plugin) and a keyed toolview for the tool, because the model narrows the call head to `read_image` and the slot is rendered from a declared child entry.

The persisted presentation metadata adds one small `{ path }` record per image read to the session log. The attachment reference is not in the log as metadata at all — it lives in the settled result content's image block — and the image bytes themselves are never logged, because the store is content-addressed and the block carries only the attachment id.

Because the card derives from `block.meta` plus the settled content, a session logged before this change carries no image metadata and replays as the generic text card. That is the documented fallback for every raw-event-derived card, not a special case here.
