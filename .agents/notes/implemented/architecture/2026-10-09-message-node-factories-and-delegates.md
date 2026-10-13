# Agent Note: Domain image Slots and a shared gallery Factory

Status: implemented

English | [中文](2026-10-09-message-node-factories-and-delegates.zh.md)

## Problem

User messages, assistant output, Trajectory records, and tool results need independently replaceable image presentation. Their official entries can share one gallery, but sharing that implementation must not merge their replacement positions or hide the caller's image-reading authority.

## Decision

Each domain declares its own image Slot and supplies the framework's `renderSlot` seat to the component that renders it. The official attachment entries use one reusable Content Factory, following the [Body Slot and Content Factory division](2026-10-09-reasoning-content-slot-factory.md).

| Entry | Declaration owner and renderer |
| --- | --- |
| `conversation.chat.user.images` Slot | The `conversation.chat.user.content` Factory declares it; `UserContent` renders it for user messages, pending steering, and local echoes. |
| `conversation.chat.message.images` Slot | The Assistant node registration declares it; `AssistantMarkdown` renders consecutive output-image groups. |
| `conversation.trajectory.images` Slot | The Trajectory view registration declares it; record attachments and tool-output blocks render it through the ledger's Slot seat. |
| `tool.call.images` Slot | The `read_image` tool-view registration declares it; `ToolRow` renders the result image. |
| `conversation.images.content` Factory | The attachment plugin registers this root-scoped gallery, implemented by `MessageImagesContent`. |

The attachment plugin fills all four image Slots with the same `MessageImages` React adapter at priority 100. A smaller priority replaces only the selected domain's entry; disposing that replacement restores the official entry. Each adapter invokes `conversation.images.content` with explicit image references, `loadImage`, and layout parameters. The shared Factory neither declares the domain Slots nor selects a domain from a scene parameter.

The image callers use their declared Slot directly; no image-entry Factory exists solely to forward one Slot call. User text remains a separate shared `conversation.user.text` Factory with its own keyed node Slot, as specified by the [user-text decision](2026-10-10-user-text-json-nodes.md).

`AssistantNodeView` passes its Slot seat and `loadImage` to `AssistantMarkdown`. User wrappers pass the loader through `UserStyleBubble` to `UserContent`. Trajectory passes its Slot seat and loader through the ledger. These paths preserve component responsibilities, image order, and keys without custom ReactNode-producing image callbacks.

Conversation owns read authorization, per-Session URL caching, and cleanup. The shared gallery never searches for a global current Session: persistent reads use the loader supplied by the caller, while submission-echo previews retain their existing browser URLs. Gallery layout, retries, thumbnails, and lightbox behavior remain in the attachment package.

`ChatView` keeps the existing `MarkdownDelegateProvider` with its wrapped file opener, external-link action, and file-image capabilities. Native-image composition does not replace Markdown image handling or its failure feedback.

`MessageImagesContentInput` accepts optional complete `MessageImageLabels`. Supplied labels are used unchanged; when omitted, the Content Factory's locale seat supplies the default copy.

## Alternatives considered

**One shared image Slot for every caller.** A replacement intended for one domain would also affect the others; shared implementation does not require shared replacement identity.

**Import the gallery component across feature packages.** This bypasses standard Slot replacement and the reusable Factory entry point.

**Pass custom image-rendering functions or supply the loader through a private Context.** Framework Slot seats already express rendering authority, while explicit loader props preserve the caller's Session authority.

## Verification

- User and output images use separate Slots; replacing either leaves the other and its mounted gallery untouched.
- Each official image entry has priority 100; a priority-0 replacement wins and disposal restores the official gallery.
- All four defaults call the same Content Factory with their original image data, authorized loader, and layout choices.
- Source order, keys, cached previews, failed-load retries, and lightbox interactions retain their existing behavior.
- The Content Factory accepts complete custom labels and resolves default labels when the caller omits them.
- Unloading the attachment implementation removes its entries without removing Slots declared by the owning domains.

## Consequences

Independent Slots allow domain-specific presentation without copying the gallery. Domain callers must forward the framework Slot seat to their plain React descendants and must supply an authorized loader at each image call. A Factory and an ordinary Slot have different lifetimes and ownership; a reusable implementation does not own every position where it appears.
