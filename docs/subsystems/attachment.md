# Durable Attachments

English | [中文](attachment.zh.md)

The attachment seam separates binary image and generic-file ownership from the session log. A producer gives bytes to [`ctx.attachments`](#ctxattachments--attachmentstore-abstract-seam); the service publishes an immutable content-addressed reference only after the object is durable. Session events and model-visible attachment blocks contain that reference and metadata, never a browser object URL, host temporary path, provider URL, or base64 payload. The independent [`ctx.fileUploads`](#ctxfileuploads--fileuploads) service binds browser file transfers and staged receipts to the receiving Agent.

Unsent browser drafts may stay in memory and native clients may stage them in operating-system temporary storage. Browser generic files become durable before they receive a staged prompt receipt. Once the host accepts a user message, its images move below `<DSH_HOME>/attachments/v1` before the user event is appended. Structured model image output follows the same persist-before-event rule.

Source: [`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## Identity and verified metadata

`AttachmentId` is a branded opaque string. The local backend currently emits `sha256:<digest>`, but consumers must neither parse that representation nor derive a filesystem path from it. A consumer may ask the attachment provider for its object location through `imageHostPath()`, then must use the current execution filesystem to decide whether model tools can read that host path.

```ts type-equiv
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
```

```ts type-equiv
/** Durable, serializable reference to one immutable normalized image. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
  /**
   * Input dimensions after applying EXIF orientation and before normalization
   * scaling. Present only when normalization reduced the image.
   */
  originalDimensions?: {
    width: number
    height: number
  }
}
```

```ts type-equiv
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}
```

The local backend admits at most 20 images and 200 MiB of encoded source data per message. One source may use up to 50 MiB, 64,000,000 pixels, and 65,535 pixels on either side. These source limits precede the independent normalization stage, which limits the long edge to 2048 pixels and encoded data to 4 MiB by default.

The reference records intrinsic dimensions and encoded length so clients can lay out history without decoding first. Reads verify the stored object against the supplied reference's ID, format, byte length, width, and height. Optional display names and pre-normalization dimensions are returned unchanged as caller-supplied display information, without verification against stored bytes.

## Commit and verified-read payloads

```ts type-equiv
/**
 * Browser-submitted prompt content accepted by Host prompt endpoints; the
 * accepting Host promotes image parts to durable references through
 * `ctx.attachments.admitPromptContent()` before any message is created, so a wire caller can
 * never cite an attachment it did not upload.
 */
type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: ImageMediaType
    readonly data: string
    readonly name?: string
  }
```

```ts type-equiv
/**
 * Host prompt content whose upload receipts are resolved. An image part
 * carries encoded bytes awaiting admission, or references an image this
 * service already stored for an upload the same Session staged, with
 * `encodedBytes` holding the byte length of that upload.
 */
type AttachmentAdmissionPart =
  | PromptContentPart
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef; readonly encodedBytes: number }
```

```ts type-equiv
/** Host-admitted prompt content with every attachment represented by its durable reference. */
type AdmittedPromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }
```

```ts type-equiv
/** Base64-encoded image upload accompanying one wire request. */
interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
```

```ts type-equiv
/** Deterministic request-image target selected by one exact model route for one attachment. */
interface ImageRequestTarget {
  /** Target width in pixels; a target above the source keeps the source width. */
  width: number
  /** Target height in pixels; a target above the source keeps the source height. */
  height: number
  /** Encoded-byte target before base64 expansion or Files API upload; the smallest quality-ladder output is kept when no quality fits. */
  maxBytes: number
}
```

```ts type-equiv
/** Integer width and height of one projected image. */
interface ProjectedDimensions {
  width: number
  height: number
}
```

```ts type-equiv
/** Cached request version derived from one provider-independent normalized attachment. */
interface RequestImageAttachment {
  /** Cache and upload-index key over the attachment id, policy, and fixed encoder parameters. */
  variantId: ImageVariantId
  /** Durable normalized attachment from which this request version was derived. */
  attachment: ImageAttachmentRef
  /** Encoded request bytes. */
  data: Uint8Array
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  /** Provider-compatible sample depth proven after request encoding. */
  depth: 'uchar'
  /** Provider-compatible color space proven after request encoding. */
  space: 'srgb'
  /** Whether the encoded request version retains an alpha channel. */
  hasAlpha: boolean
}
```

`saveImage()` prepares and atomically commits a provider-independent normalized attachment before returning its `ImageAttachmentRef`. `saveImages()` prepares every validated attachment once before publishing the batch, so validation rejection leaves no partial objects and publication does not repeat decoding or quality selection. `admitPromptContent()` accepts the complete ordered Host prompt after upload receipt resolution, replaces base64 image uploads with durable references, passes durable file references and already stored images unchanged, and counts every image toward the per-message image count and aggregate byte limits, a stored image by the bytes of its upload. `admitEncodedImages()` supports other wire entries and delegates count, aggregate-byte, and ordered batch admission to `saveImages()`. `admitEncodedFile()` gives encoded protocol adapters the same service-owned canonical-base64 admission, and `isAttachmentError()` lets those adapters recognize stable attachment failures without importing implementation helpers. `readImage()` verifies a normalized object against the supplied complete reference without consulting Session history, then returns that reference with the bytes. Access policy belongs to the calling API; Session Controller uses the store-level [image access rule](../../.agents/notes/implemented/architecture/2026-10-23-store-scoped-image-reads.md). `imageHostPath()` exposes only the provider-owned host object location; it does not decide whether the current tool execution world can read it. `readImageRequest()` derives and caches one deterministic request version at an exact route-chosen target size and encoded-byte target. That version contains encoded bytes and metadata but no execution-world path. New entries are fully decoded before publication, while cache hits use a bounded metadata probe. Callers use `Promise.all` over the singular method when they need an ordered batch. The local implementation lazily encodes preferred candidates, singleflights equal request identities, lets each waiter cancel independently, stops shared work when no waiter remains, and bounds all transforms with its instance-level limiter, which defaults to two simultaneous transformations. The service is retention-neutral: resumed and forked sessions may share objects, so reference-aware garbage collection is deferred rather than tied to one session's deletion.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxattachments--attachmentstore-abstract-seam"></a>

### `ctx.attachments` — `AttachmentStore` (abstract seam)

Immutable binary attachment service. Implementations validate bytes before publishing a reference.

```ts cordis-catalog
/**
 * Validate one image without persisting it.
 * Batch callers validate every member before saving any member.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns completion after the encoded raster has been fully decoded.
 */
abstract validateImage(input: SaveImageAttachment): Promise<void>

/**
 * Validate and durably commit one ordered image batch.
 * @param inputs - encoded images in owning-message order.
 * @returns durable normalized attachment references in the same order after every member succeeds.
 */
async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>

/**
 * Admit one Host prompt and replace each encoded image with its durable reference.
 * Text, durable file references, and already stored images pass through unchanged.
 * Every image part counts toward `maxImagesPerMessage` and `maxMessageImageBytes`;
 * a stored image counts the bytes of the upload that stored it. Refused content
 * starts no writes. A prompt without encoded images performs no storage operation.
 * @param content - prompt parts in message order after upload receipt resolution.
 * @returns admitted prompt parts in the same order as `content`.
 * @throws AttachmentError when the image batch is refused.
 */
async admitPromptContent( content: readonly AttachmentAdmissionPart[], ): Promise<AdmittedPromptContentPart[]>

/**
 * Decode and durably commit one canonical base64 file upload.
 * @param input - canonical base64 bytes and optional display name.
 * @returns the durable content-addressed file reference.
 * @throws AttachmentError when the encoding or storage operation is refused.
 */
admitEncodedFile(input: EncodedFileAttachment): Promise<FileAttachmentRef>

/**
 * Identify a failure emitted by this attachment capability by its stable code.
 * @param error - value caught from an attachment operation.
 * @returns whether the value is an attachment failure.
 */
isAttachmentError(error: unknown): error is AttachmentError

/**
 * Validate and durably commit one image before its owning session event is appended.
 * The returned reference describes the persisted normalized image. When
 * normalization reduces the raster, its `originalDimensions` records the
 * orientation-applied input dimensions.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns the durable content-addressed normalized image reference.
 */
abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

/**
 * Read one image and verify its ID, format, byte length, and dimensions against the supplied reference.
 * @param ref - supplied image reference; name and originalDimensions are preserved without file verification.
 * @param signal - optional cancellation for backend read and verification work.
 * @returns the verified bytes and normalized attachment reference.
 * @throws the signal reason when aborted, or a storage error when verification fails.
 */
abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

/**
 * Locate the provider-owned normalized object in the harness host filesystem.
 * @param ref - durable normalized attachment reference.
 * @returns an absolute host path, or undefined when this backend is not host-file-backed.
 * @throws an AttachmentError when the durable reference is invalid.
 */
imageHostPath(ref: ImageAttachmentRef): string | undefined

/**
 * Durably commit one file byte-for-byte before its owning session event is
 * appended. Files carry no admission limits: any byte content and length is
 * accepted, and the stored object is the exact submitted bytes. Backends
 * without verbatim file storage keep this default rejection.
 * @param input - exact bytes and optional display name.
 * @returns the durable content-addressed file reference.
 */
saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>

/**
 * Durably commit one file byte-for-byte from bounded chunks. Providers must
 * apply backpressure and must not collect the complete file in memory.
 * Backends without streamed verbatim storage keep this default rejection.
 * @param input - ordered exact bytes, optional cancellation, and display name.
 * @returns the durable content-addressed file reference.
 */
saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef>

/**
 * Read and verify one verbatim stored file as bounded chunks. Providers must
 * not collect the complete file in memory. Backends without verbatim file
 * reads keep this default rejection.
 * @param ref - durable file reference from the session log.
 * @param signal - optional cancellation for backend reads and verification work.
 * @returns exact file bytes in order; integrity failures reject the iteration.
 */
async *readFileStream( ref: FileAttachmentRef, signal?: AbortSignal, ): AsyncIterable<Uint8Array>

/**
 * Locate the verbatim stored file object in the harness host filesystem.
 * @param ref - durable file reference.
 * @returns an absolute host path, or undefined when this backend is not host-file-backed.
 * @throws an AttachmentError when the durable reference is invalid.
 */
fileHostPath(ref: FileAttachmentRef): string | undefined

/**
 * Generate or read one deterministic model-request version from the stored normalized image.
 * @param ref - durable provider-independent normalized attachment reference.
 * @param target - route-chosen dimensions and byte target; an unmet byte target yields the smallest ladder output.
 * @param signal - optional cancellation.
 * @returns request bytes and the cache/upload identity covering every transform input.
 */
readImageRequest( ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal, ): Promise<RequestImageAttachment>
```

Source: [`packages/attachment/attachment/src/index.ts`](../../packages/attachment/attachment/src/index.ts)

<a id="ctxfileuploads--fileuploads"></a>

### `ctx.fileUploads` — `FileUploads`

Host service owning upload storage and receipts keyed by each receiving Agent's exact Session.

```ts cordis-catalog
/**
 * Register the ordinary-Session resolver used when a raw upload addresses a cold Session.
 * @param resolve - resolver that returns the exact live Agent or throws a Remote error.
 * @returns disposer removing this resolver.
 */
registerAgentResolver(resolve: AgentResolver): () => void

/**
 * Persist one encoded upload and stage it under the Agent receiver selected by Typert.
 * @param agent - receiving Agent resolved from the Remote Agent scope.
 * @param request - canonical base64 bytes and optional display name.
 * @param signal - caller cancellation before storage begins.
 * @returns the staged receipt and durable file reference.
 */
@Remote('upload') async upload(agent: Agent, request: EncodedFileUploadRequest, signal: AbortSignal): Promise<FileUploadValue>

/**
 * Persist raw chunks for one Session without aggregating the upload.
 * @param request - Session identity, ordered bytes, cancellation, and optional display name.
 * @returns the staged receipt and durable file reference.
 */
async uploadStream(request: { readonly sessionId: SessionId readonly data: AsyncIterable<Uint8Array> readonly signal?: AbortSignal readonly name?: string }): Promise<FileUploadValue>

/**
 * Persist one prompt image for a Session: read at most the smaller of the
 * deployment's per-image and per-message byte limits, then validate,
 * normalize, and store the image the way prompt admission does, so a later
 * prompt cites it by receipt.
 * Cancellation before storage begins stores nothing; a cancelled upload
 * never receives a receipt, although an image whose storage already began
 * stays in the content-addressed store.
 * @param request - Session identity, ordered bytes, the declared media type that this deployment
 * must accept, cancellation, and optional display name.
 * @returns the staged receipt and durable normalized image reference.
 */
async uploadImageStream(request: { readonly sessionId: SessionId readonly data: AsyncIterable<Uint8Array> readonly mediaType: string readonly signal?: AbortSignal readonly name?: string }): Promise<ImageUploadValue>

/**
 * Resolve one staged receipt for the receiving Agent's exact Session.
 * @param agent - receiving Agent.
 * @param receiptId - opaque receipt minted for one completed upload.
 * @returns the staged file or image, or `undefined` for an unknown or foreign receipt.
 */
resolve(agent: Agent, receiptId: FileUploadReceiptId): StagedAttachment | undefined

/**
 * Bind receipts while one prompt enters an Agent inbox.
 * Disposal restores every prior binding unless the caller commits successful delivery.
 * @param agent - receiving Agent.
 * @param receiptIds - distinct staged receipts referenced by the prompt.
 * @param requestId - prompt identity later observed in queue or history.
 * @returns binding kept after commit until queue or history observation retires its receipts.
 */
bindPrompt( agent: Agent, receiptIds: readonly FileUploadReceiptId[], requestId: string, ): PromptFileBinding

/**
 * Retire every receipt accepted by one removed queue occurrence.
 * @param agent - receiving Agent.
 * @param requestId - prompt identity carried by the queue occurrence.
 */
retirePrompt(agent: Agent, requestId: string): void
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/client/file-upload/src/index.ts`](../../packages/client/file-upload/src/index.ts)
<!-- END GENERATED cordis-surface -->
