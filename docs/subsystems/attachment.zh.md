# 持久附件

[English](attachment.md) | 中文

附件 seam 将二进制图片和通用文件的所有权与会话日志分离。生产方把字节交给 [`ctx.attachments`](#ctxattachments--attachmentstore-abstract-seam)；只有对象完成持久化后，该服务才会发布不可变的内容寻址引用。会话事件和模型可见的附件块包含该引用及其元数据，绝不包含浏览器对象 URL、宿主临时路径、提供方 URL 或 base64 数据。独立的 [`ctx.fileUploads`](#ctxfileuploads--fileuploads) 服务把浏览器文件传输与暂存凭证绑定到接收方 Agent。

未发送的浏览器草稿可以保留在内存中，原生客户端也可以将其暂存于操作系统临时存储。浏览器通用文件取得暂存 prompt 凭证前会完成持久化。宿主接受用户消息后，会先把消息中的图片移到 `<DSH_HOME>/attachments/v1` 下，再追加用户事件。结构化模型图片输出遵循同样的先持久化、后追加事件规则。

来源：[`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## 标识与经过校验的元数据

`AttachmentId` 是带类型标记的不透明字符串。本地后端目前生成 `sha256:<digest>`，但消费方既不能解析这种表示，也不能据此派生文件系统路径。消费方可以通过 `imageHostPath()` 询问附件提供方所持对象的位置，然后必须由当前执行文件系统判断模型工具能否读取该宿主路径。

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

本地后端每条消息最多准入 20 张图片，源图编码数据总量不超过 200 MiB。单张源图不得超过 20 MiB、64,000,000 像素和单边 8192 像素。这些源文件限制先于独立的规范化阶段执行；该阶段默认把长边限制为 2048 像素，把编码数据限制为 4 MiB。

引用记录固有尺寸和编码长度，使客户端无需先解码即可排布历史记录；每次权威读取仍会根据对象重新校验摘要、媒体签名、尺寸和元数据。

## 提交与经校验读取的数据

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
/** Host prompt content whose file receipts are resolved and whose image bytes await admission. */
type AttachmentAdmissionPart =
  | PromptContentPart
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }
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
/** Deterministic request-image policy selected by one exact model route. */
interface ImageRequestPolicy {
  /** Maximum width multiplied by height after aspect-preserving projection. */
  maxPixels: number
  /** Encoded-byte target before base64 expansion or Files API upload; the smallest quality-ladder output is kept when no quality fits. */
  maxBytes: number
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

`saveImage()` 准备并原子提交提供方无关的规范化附件，然后直接返回 `ImageAttachmentRef`。`saveImages()` 在发布批次前为每个成员各准备一次经过验证的附件，因此校验拒绝不会留下部分对象，发布也不会重复解码或选择质量。`admitPromptContent()` 在文件凭证解析后接收完整且有序的 Host prompt，把 base64 图片上传替换为持久引用，并让持久文件引用原样通过。`admitEncodedImages()` 支持其他 wire 入口，把张数、聚合字节和有序批量准入交给 `saveImages()`。`admitEncodedFile()` 让编码协议适配器使用服务拥有的规范 base64 准入，`isAttachmentError()` 让这些适配器无需导入实现辅助函数即可识别稳定的附件错误。`readImage()` 校验来自已授权会话路径的规范化附件。`imageHostPath()` 只公开提供方所持对象的宿主位置，不判断当前工具执行环境能否读取它。`readImageRequest()` 按确切路由的像素和字节预算派生并缓存确定性请求版本。该版本包含编码字节和元数据，不包含执行环境路径。新条目在发布前完整解码，缓存命中只做有界元数据探测。调用方需要有序批次时，对单数方法使用 `Promise.all`。本地实现按需编码首选候选、合并相同请求身份的并发任务、允许每个等待方单独取消、没有等待方时停止共享任务，并通过实例级限流器限制全部变换，默认同时执行两项。该服务不规定保留策略：恢复和 fork 后的会话可能共享对象，因此基于引用的垃圾回收会延期实现，不与单个会话的删除绑定。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * Admit one Host prompt and replace each uploaded image with its durable reference.
 * Text and durable file references pass through unchanged. A prompt without image parts performs no storage operation.
 * @param content - prompt parts in message order after file receipt resolution.
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
 * Read one image and verify that bytes still match the recorded reference.
 * @param ref - durable reference from the session log.
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
 * @param ref - durable reference from the session log.
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
 * @param policy - exact route pixel budget and encoded-byte target; a target no ladder quality meets yields the smallest ladder output.
 * @param signal - optional cancellation.
 * @returns request bytes and the cache/upload identity covering every transform input.
 */
readImageRequest( ref: ImageAttachmentRef, policy: ImageRequestPolicy, signal?: AbortSignal, ): Promise<RequestImageAttachment>
```

Source: [`packages/attachment/attachment/src/index.ts`](../../packages/attachment/attachment/src/index.ts)

<a id="ctxfileuploads--fileuploads"></a>

### `ctx.fileUploads` — `FileUploads`

Host service owning upload storage and Agent-scoped staged receipts.

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
@Remote('upload') upload(agent: Agent, request: EncodedFileUploadRequest, signal: AbortSignal): Promise<FileUploadValue>

/**
 * Persist raw chunks for one Session without aggregating the upload.
 * @param request - Session identity, ordered bytes, cancellation, and optional display name.
 * @returns the staged receipt and durable file reference.
 */
async uploadStream(request: { readonly sessionId: SessionId readonly data: AsyncIterable<Uint8Array> readonly signal?: AbortSignal readonly name?: string }): Promise<FileUploadValue>

/**
 * Resolve one staged receipt inside its receiving Agent scope.
 * @param agent - receiving Agent.
 * @param receiptId - opaque receipt minted for one completed upload.
 * @returns durable file reference, or `undefined` for an unknown or foreign receipt.
 */
resolve(agent: Agent, receiptId: FileUploadReceiptId): FileAttachmentRef | undefined

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

Types: [Agent](core.zh.md) · [SessionId](core.zh.md)

Source: [`packages/client/file-upload/src/index.ts`](../../packages/client/file-upload/src/index.ts)
<!-- END GENERATED cordis-surface -->
