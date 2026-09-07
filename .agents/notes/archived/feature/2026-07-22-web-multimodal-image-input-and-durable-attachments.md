# Agent Note: Web multimodal image input and durable attachments

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-22-web-multimodal-image-input-and-durable-attachments.zh.md)

## Problem

Before this change, the Web composer accepted only text: `InputBar` received a string draft, `ConversationController.send()` created text content, and the host forwarded that content to the agent. Users could not paste an image, inspect it before sending, submit an image-only prompt, or recover sent images from history.

This is not only a composer gap. Core needs a durable image content block, providers need explicit modality handling, and the session log must reconstruct everything visible to a model. [The previous image-block removal](../../archived/simplification/2026-07-04-drop-image-content-block.md) rejected a partial design that could silently lose or flatten images. A browser object URL, local path, provider URL, or base64 payload cannot be canonical session content.

The [Web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md) keeps components pure and per-session composer state in `ctx.conversation`; the [archived GUI layering and RPC protocol decision](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) makes durable events the source of truth for both live rendering and history replay. Image intake, persistence, provider conversion, and rendering therefore need one explicit lifecycle.

Peer products converge on an attachment rail above the editor, but their storage choices differ. Codex-style paths such as `/var/folders/.../codex-clipboard-*.png` are reasonable intake staging locations, not durable message identities: the operating system may delete them, another host cannot read them, and a resumed session cannot rely on them.

## Decision

Pasted or dropped raster images are the Web composer's first consumer of a durable attachment capability. Unsent files remain temporary client-owned draft state. Every rich-content intake adapter decodes its wire blocks, proves route capability, and delegates the complete image batch to the attachment service before appending its message event. A provider adapter that produces structured image output must durably commit the output before appending its assistant block. Canonical user and assistant content contains only role-neutral `ImageBlock` references.

Version one supports PNG, JPEG, WebP, and GIF paste and drag-and-drop, image-only or mixed prompts, historical user and assistant image rendering, and original-image preview on a single click (display and interaction specifics superseded in part by the [attachment-display alignment note](2026-08-11-web-attachment-display-alignment.md)). File picking, generic files, PDF, audio, video, image copying, and a custom context menu remain separate follow-ups.

### Product behavior

- Pasting or dropping one or more supported images adds ordered thumbnails above the textarea without inserting placeholder text. Dragging files over the composer highlights the drop target.
- The same resident `InputBar` renders the rail in both blank-session Hero and active-session layouts. The rail is hidden when empty and scrolls horizontally instead of widening the composer.
- Each 64-by-64-pixel thumbnail carries a hover-revealed remove control inside the card and opens its original draft image on a single click; overflow pages with edge arrows instead of a visible scrollbar.
- A prompt may contain text and images or images only. Pure text paste remains native browser behavior; mixed clipboard content inserts its text normally while adding its files to the rail, and file-only paste prevents default browser handling. File drops on the composer always prevent browser navigation and report unsupported files locally.
- A failed send restores the complete text and image draft without clobbering text or images added while the request was in flight. Removal, successful send, session-scope disposal, rendered-history disposal, and application disposal revoke the object URLs they own.
- Historical user and assistant images use one `MessageImage` control. Inline images preserve intrinsic aspect ratio, do not upscale, and stay within a 240-by-240-pixel box.
- Clicking a message image opens the stored original in a viewport-bounded modal. Escape, the close control, and backdrop activation close it and restore focus.
- Version one does not override the browser context menu and provides no explicit image-copy action.

### Storage lifecycle and ownership

The persistence boundary is message acceptance, not paste:

| State | Allowed representation | Durability and ordering |
| --- | --- | --- |
| Unsent user draft | Browser `File` plus object URL; a native client may use an OS temporary file such as `/var/...` | Temporary and client-owned. It may disappear on reload or process exit and never appears in a session event. |
| Accepted user image | Immutable object below `DSH_HOME` plus `ImageAttachmentRef` | The host commits every image before `agent.send()` or `agent.steer()` can append the owning user event. |
| Structured model image output | Immutable object below `DSH_HOME` plus `ImageAttachmentRef` | The provider adapter commits the bytes before it emits a completed image block or assistant message event. Temporary URLs, paths, and base64 are forbidden in the event. |

Each session's `InputMachine` state keeps the ordered runtime-only attachment identifiers alongside the live draft. The framework-owned chat store receives only the draft's plain-text persistence mirror, while `ConversationController` owns the corresponding browser-only `File` and object-URL registry:

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

type DraftAttachmentId = Branded<'DraftAttachmentId'>

interface ChatStoreState {
  selection: object | null
  draft: string
  view: string | null
}

interface InputState {
  draft: string
  imageIds: readonly DraftAttachmentId[]
}

interface ComposerAttachment {
  kind: 'image'
  id: DraftAttachmentId
  file: File
  previewUrl: string
}
```

This split uses the session provide channel's input hook and actions as the single subscription path for live composer state while keeping non-serializable browser objects out of persisted JSON. Only the plain-text draft mirror uses `localStorage`; attachment identifiers, browser `File` objects, and object URLs remain scoped to the live session input shell. Unsent images therefore do not survive reload or session-scope disposal. A Workspace switch moves a mixed text-and-image draft only when the destination shell accepts the complete image batch; refusal leaves both parts with the source. A native client may stage input in an OS temporary directory, but it must treat that path exactly like the browser object URL: delete it when no longer needed and copy the bytes into the durable store before message acceptance.

The local attachment backend resolves an explicit `dshHome`, then `$DSH_HOME`, then `~/.dsh`. It stores content-addressed objects below `$DSH_HOME/attachments/v1/objects/<prefix>/<sha256>` with owner-only directory and file permissions. On each process's first save for one home, it creates that home and synchronizes every ancestor entry to the filesystem root; existence is not treated as durability because another process may still be between `mkdir` and parent `fsync`. A temporary file is then written, synchronized, atomically published, and made durable with directory syncs on the publication path (POSIX; Windows relies on filesystem metadata journaling) before the service returns a reference. The content digest is encoded in the opaque `sha256:<digest>` identifier. Admission prepares a provider-independent master by applying orientation, removing metadata, converting to 8-bit sRGB/sRGBA, and preserving aspect ratio under independent dimension and byte limits. Reads verify the digest, byte length, and logged metadata. Route-specific deterministic request versions are cached separately; the full policy is recorded in [Unified image masters, request versions, and provider files](2026-08-20-unified-image-request-pipeline.md).

The store performs no automatic deletion in version one. Sent user images and model-generated images remain reachable for history, resume, and fork. Reference-aware garbage collection needs a separate design because an age-only rule can delete data still referenced by a durable session. Deployment byte and pixel limits are admission policy on writes; reads verify the digest and recorded metadata without reapplying current admission limits, so lowering policy does not invalidate older history.

### Durable content and prompt wire

The attachment seam exposes immutable image write and verified read operations. The canonical metadata is deliberately narrower than a generic file record:

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

type AttachmentId = Branded<'AttachmentId'>

interface ImageAttachmentRef {
  attachmentId: AttachmentId
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
}
```

`ImageBlock` joins the merge-extensible core `ContentBlockMap` and is valid in either user or assistant content. It never carries base64, an object URL, a filesystem path, or a provider-owned locator. This keeps the session event plus immutable object store sufficient to reconstruct the exact model-visible image. The LLM vocabulary therefore has a type-only dependency on the attachment seam; provider runtime dependencies remain adapter-specific.

The browser cannot mint a durable reference, so `session.prompt` accepts a narrow intake union rather than canonical `ContentBlock[]`:

```ts
export {}

type PromptInputPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      data: string
      name?: string
    }
```

Base64 crosses a wire boundary once and is discarded after persistence. Each front door validates canonical base64 and declared MIME fields, then calls `AttachmentStore.saveImages()` with the whole decoded batch. The service owns image count, aggregate bytes, individual bytes, fully decoded raster/MIME agreement, intrinsic dimensions, decoded-pixel count, and master preparation. It prepares and verifies every batch member once before publishing any member, so one malformed image cannot create partial references and large images are not decoded and encoded again at commit. Storage commits then run in submission order. If a later storage I/O operation fails, the caller appends no model-visible event and receives no partial references, but an earlier immutable content-addressed object may remain unreferenced under the existing storage rule. Only after every image succeeds does the front door call the agent with normalized text and durable image blocks in wire order. A failure exposes no attachment path or raw bytes.

`session.attachment` is a read-only, session-scoped endpoint. The host serves bytes only when a durable event in that session references the requested attachment identifier. The client deduplicates loads by session and attachment identifier while that session is rendered, revokes resolved URLs on rendered-session disposal, and rejects invalidated late loads before allocating an object URL so an unmounted session or disposed service cannot repopulate the cache.

### Model capabilities and provider behavior

Model catalog entries gain optional merge-extensible input modality declarations. A missing declaration means unknown; a present list without `image` is an explicit negative capability.

The host is the authoritative preflight point. It resolves the session's latest routed provider and model, falling back through agent options to host defaults; if that model explicitly excludes image input, it rejects a new image prompt before writing an attachment or event, and the client restores the draft. Image-bearing prompt admission and model selection share one per-agent serial chain ([ordering decision](../bug-fix/2026-07-29-atomic-web-image-admission.md)), including steering that does not enter the queued UI mirror. This gives a prompt and concurrent selection a deterministic order. Selection itself may target a text-only model after images enter durable history; the shared LLM runtime replaces retained image blocks with deterministic text placeholders for that request. `session.updateQueue` edits accept text content only, so a queue edit cannot inject an image past admission. Unknown capability proceeds to the adapter guard so uncatalogued model identifiers remain usable. The browser rejects unsupported declared image media types before allocating preview URLs, but it does not snapshot deployment limits or model capability. The host validates the complete batch against current byte, count, aggregate, media, dimension, pixel, and routed-model policy before writing an attachment or event; its rejection appears through the composer's transient toast.

Pi-AI and the direct DeepSeek adapter resolve `ctx.attachments` at request time, recursively convert each retained image reference including references nested inside tool results, and emit native image content only for models that declare image input. Both adapters request the same deterministic route-specific version from the durable normalized attachment. Pi-AI carries it inline under a base64-aware request budget. The built-in DeepSeek route advertises `deepseek-v4-flash-vision-exp`, uploads every retained version through Files API, and sends `file_id` blocks with indexed reuse, expiry, bounded stale-id retry, quota cleanup, and explicit deletion. DeepSeek text models, custom models without an image declaration, and unlisted pass-through ids remain text-only. Request-time service resolution keeps Cordis load order from freezing optional attachment availability. No adapter may flatten or silently skip a retained image; unsupported roles and models fail with typed `UNSUPPORTED_CONTENT`.

Core supports structured assistant image blocks, but no current production provider route is certified for image output. Any future output-capable adapter must retrieve provider bytes under bounded size and time policy, validate them through the same attachment service, persist them, and only then publish the atomic `ImageBlock`. A URL in assistant Markdown remains text and is never downloaded automatically.

Provider-neutral token estimation does not guess visual pricing from image dimensions; provider-reported usage remains authoritative. ACP advertises image prompts only when its configured exact route and attachment deployment can accept them, persists inline input before publishing the user event, and re-reads committed assistant image references for native ACP image updates. MCP keeps canonical raw blocks for programmatic callers while projecting admitted images to durable core blocks; PTC mode carries any settled image-bearing sub-result through the outer result as logged source-attributed context.

Compaction replays the selected conversation prefix, including image references, into the configured summarization route. A visual-capable route uses the same deterministic request versions as ordinary turns. A text-only route receives the same deterministic attachment placeholders as any other LLM request. The synthesized checkpoint remains text-only, and `compaction-basic` rejects image summary output with `UNSUPPORTED_CONTENT`.

### History rendering and original preview

History folding preserves `ImageBlock` in both user and assistant messages. User images align to the trailing edge above their text; assistant images remain in their original content-block position in the leading narration flow. `MessageImage` derives a stable inline box from recorded dimensions, resolves bytes through the session-authorized loader, uses `object-fit: contain`, and turns a missing or corrupt object into a retryable error control.

Composer thumbnails and each `MessageImage` own ephemeral original-preview state and invoke the same pure `ImageLightbox`. The modal uses the already resolved original object URL, constrains only display size, focuses its close control, and restores the previous focus target when closed.

### Limits and trust boundaries

Version one accepts PNG, JPEG, WebP, and GIF only. SVG and remote URLs are excluded. Source intake defaults are 32 MiB per image, 20 images and 100 MiB aggregate image bytes per message, 100 million decoded pixels per image, and 16384px on either side. The provider-independent master defaults to a 2048px long edge and 4 MiB safety cap. Provider request pixel and encoded-byte limits are separate route policies. These deployment-varying limits are validated backend configuration and enforced before persistence or request transmission. The client connection carrier has an independent configurable `maxRequestBodyBytes` cap, 160 MiB by default, and fails load if it cannot hold the aggregate source limit after base64 and envelope expansion. A body without a declared length is rejected when it crosses the cap rather than drained to its end.

Malformed base64, unsupported or mismatched media, truncated image payloads, excess bytes, excess image count, excess pixels, excess per-side dimensions, missing objects, and integrity mismatches return stable structured failures. Original filenames are reduced to a display basename, control characters are removed, and no local path is logged or returned to the browser.

### Package and surface changes

| Surface | Responsibility |
| --- | --- |
| `packages/attachment/attachment` | Opaque attachment and request-version identifiers, image references, policies, failures, batch admission, derived reads, and crops through `ctx.attachments`. |
| `packages/attachment/attachment-local` | Private content-addressed masters, deterministic request cache, complete raster decoding, integrity verification, and configuration. |
| `packages/llm/llm` | Role-neutral `ImageBlock`, input-modality metadata, exact adapter generations, and text-only request projection. |
| `packages/llm/llm-pi-ai` | Resolve durable images to deterministic inline request versions. |
| `packages/llm/llm-deepseek` | Resolve official vision input to deterministic request versions and Files API ids. |
| `packages/compaction/compaction-basic` | Preserve images in summary input and reject non-text checkpoint output explicitly. |
| `packages/host/apiproxy` and `packages/bundle/base` | Narrow upload wire, shared batch admission, limits and routed-model preflight, persist-before-event ordering, session-authorized reads, and default profile composition. |
| `packages/client/connection` and `packages/client/runtime` | Bounded request buffering, wire types, fixture images, prompt uploads, attachment reads, and durable-reference folding. |
| `packages/client/ui-conversation` | Per-session draft images, attachment rail, user and assistant image controls, and original preview. |
| `packages/acp/acp` | Conditional native image capability, atomic inline-image admission, and verified assistant-image delivery. |
| `packages/mcp/mcp-client` | Lossless canonical MCP results plus capability-gated durable image projection and explicit diagnostics for unsupported rich blocks. |
| `packages/core/tools` | Generic PTC mode forwarding of settled image-bearing sub-results after the outer result. |

The attachment packages form the interface/implementation side of one capability seam. Composer behavior stays in the conversation object layer, provider conversion stays in adapters, and no change is required in `agent-loop`.

### Implementation

The implemented capability includes shared prepare-once batch admission, provider-independent masters, deterministic request versions, DeepSeek Files reuse, stable crop handles, role-neutral image blocks, Pi-AI and DeepSeek input conversion, durable Web/ACP/MCP ordering, Web upload/read protocol, conditional ACP image support, lossless MCP results with durable image projection, PTC mode rich-result forwarding, bounded Web requests, draft and historical image UI, compaction handling, and keyless assembled coverage.

No compatibility shim is required for the pre-release prompt wire; all call sites and fixtures change with the introducing slice.

## Alternatives considered

### Keep every intake image in `/var` or another temporary directory

Temporary storage is appropriate before send, including for a native client that receives clipboard files through the operating system. It is not appropriate after acceptance: cleanup is outside the harness's control, paths are host-specific, and resume or fork can outlive the file. The proposal permits temporary staging but copies accepted bytes into `DSH_HOME` before the event.

### Persist immediately on paste or drop

Immediate persistence makes drafts reload-resistant but creates durable objects before a session or message owns them, which requires quota, orphan lifetime, and cleanup policy. Version one keeps the unsent draft temporary and makes send acceptance the durability boundary.

### Inline base64 in messages and session logs

This duplicates binary data across RPC, events, history pages, forks, compaction, and browser storage, and invites token accounting to treat encoding text as model text. One immutable object plus small references keeps the durable representation bounded.

### Use browser object URLs, local paths, or provider URLs as canonical content

Object URLs expire with the document, local paths are not portable, and provider URLs may expire, track viewers, or expose credentials. They remain temporary transport or preview details only.

### Use one generic `AttachmentBlock` for images, files, audio, and video

Composer presentation can use a generic attachment rail, but provider semantics are modality-specific. Images are native multimodal input; PDFs may be provider files or extracted text; video may be native, sampled, or unsupported. A specific `ImageBlock` forces every consumer to handle or reject the modality explicitly.

### Rely on UI capability checks or silently filter images

UI state can be stale and does not protect direct SDK, ACP, replay, or uncatalogued model paths. Silent filtering changes user intent. Provider enforcement remains mandatory, while UI checks are optional earlier feedback.

### Add a generic RichContent service above the core content vocabulary

Rejected because the core already has the role-neutral `ContentBlock` vocabulary and attachment references. A second generic service would duplicate ordering, capability, logging, and lifetime semantics while still requiring each wire adapter to parse its own protocol. Narrow image adapters around the existing core preserve ownership and leave audio/resources to earn their own lifecycle contracts.

### Normalize MCP results into core content as the canonical tool value

Rejected because PTC mode and programmatic callers need the complete MCP JSON blocks and optional `structuredContent`; replacing that value with a Native projection would make the bridge lossy. MCP retains the protocol value and prepares a separate model projection, with final post-execute policy remaining authoritative.

### Perform attachment reads and writes inside synchronous output renderers

Rejected because tool renderers are pure, synchronous, and replayable. MCP prepares image projection during async execution and installs it only at the registry's finalization boundary; ACP performs async admission and output conversion in its transport lifecycle. PTC mode forwarding observes the already settled final content instead of giving individual image tools private parent-token behavior.

## Testing

- Storage tests cover content-addressed deduplication, private permissions, admission failures, corruption/missing-object failures, and reading history after deployment limits are lowered.
- Host and protocol tests cover persist-before-event ordering, absence of base64 in logs, session-scoped authorization, capability rejection, upload limits, bounded HTTP request bodies, image-admission/model-selection ordering, text-only queue edits, and text-only request projection.
- Client unit tests cover paste and drop, mixed clipboard text, image-only send, draft restoration, ordering, draft/session-scope/application object-URL cleanup, and a deferred historical read that completes after disposal; the keyless assembled built-client lane (`apps/web/tests/image-display.expected.e2e.ts`, `pnpm run test:web`) covers the historical user and assistant galleries over the authorized attachment route, the original-size lightbox, and the composer paste rail.
- Adapter and compaction tests cover deterministic Pi-AI request versions, DeepSeek Files upload and reuse, stale-id recovery, text-only projection, recursively nested tool-result images, shared summary request versions, and explicit image-output rejection.
- Attachment, MCP, ACP, and PTC mode tests cover all-member validation before writes, mixed text/image ordering, no inline base64 in durable events, exact route-capability gates, explicit unsupported-content diagnostics, post-execute replacement/block precedence, cancellation during admission, verified assistant-image delivery, and generic nested-image forwarding. A keyless assembled ACP snapshot sends a real inline PNG and pins only its durable reference in the session log.
- Credentialed real-API tests cover the configured Anthropic route and the built-in `deepseek-official` Files path. The DeepSeek test does not use a custom provider entry.
- The current production adapter set has no certified image-output route; output-provider certification remains outside version one.

## Consequences

- Durable storage grows without garbage collection. Version one chooses replay safety over premature deletion.
- A missing or corrupt object makes exact model reconstruction fail. Failing loud preserves integrity but may prevent that session from continuing until repaired.
- JSON-RPC base64 adds upload memory and roughly one-third encoding overhead. Version-one limits bound it; larger media needs streaming or a binary transport.
- Unsent images do not survive reload. Durable drafts need quota and orphan cleanup rather than reusing message storage implicitly.
- Original preview decodes more pixels than the inline control displays. Pixel limits, one clicked preview, and object-URL disposal bound but do not eliminate transient browser memory.
- Capability metadata may be missing or stale. Host preflight improves feedback, while adapter enforcement remains authoritative.
- A future output provider may require authenticated retrieval before an assistant image can complete, adding latency and a new failure point. Persist-before-event ordering favors replay integrity.
- File picking, generic files/PDF, audio/video, durable draft staging, image copying, custom context menus, output-provider certification, and reference-aware garbage collection remain independent designs.
