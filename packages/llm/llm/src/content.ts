/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock, ImageBlock, LlmImageRequestBudget, ToolSchema, ToolUpdate, ToolHistory } from './types.ts'
import type { RequestMessage } from './types.ts'
import type { Message } from './message.ts'
import type {
  AttachmentStore, FileAttachmentRef, ImageAttachmentRef, ImageMediaType, RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Execution-world path that model tools can use to read one normalized attachment. */
export interface ImageAttachmentAccess {
  /** Absolute path to immutable normalized bytes; callers must treat it as read-only. */
  readonlyPath: string
}

/**
 * Resolve current execution-world access for one durable image reference.
 * @param ref - durable normalized attachment reference.
 * @returns a read-only execution-world path, or undefined when unavailable.
 */
export type ImageAttachmentAccessResolver = (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined

/**
 * Bridge one attachment provider's host object location into the mounted
 * tool execution world. The consumer supplies the current filesystem
 * provider's mapping without making attachment or LLM definitions depend on it.
 * @param attachments - provider that owns the normalized attachment object.
 * @param mapHostPath - map one absolute host path into the current tool execution world.
 * @param ref - durable normalized attachment reference.
 * @returns a read-only execution-world path, or undefined when either provider exposes no mapping.
 * @throws an attachment error when the durable reference is invalid.
 */
export function resolveImageAttachmentAccess(
  attachments: AttachmentStore,
  mapHostPath: (hostPath: string) => string | undefined,
  ref: ImageAttachmentRef,
): ImageAttachmentAccess | undefined {
  const hostPath = attachments.imageHostPath(ref)
  if (hostPath === undefined) return undefined
  const readonlyPath = mapHostPath(hostPath)
  return readonlyPath === undefined ? undefined : { readonlyPath }
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function imageIdentity(ref: ImageAttachmentRef): string {
  return ref.name === undefined
    ? String(ref.attachmentId)
    : `${quoted(ref.name)} (${ref.attachmentId})`
}

function extension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return assertNever(mediaType, 'image extension')
  }
}

function normalizedAccessText(ref: ImageAttachmentRef, access: ImageAttachmentAccess): string {
  return ` Normalized copy (read-only; may be resized or re-encoded): ${quoted(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}).`
    + ' Source dimensions, format, and byte size may differ.'
    + ` Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`
}

/**
 * Stable text shown to a model that cannot accept one durable image reference.
 * @param ref - durable normalized attachment omitted from the request.
 * @returns deterministic text-only placeholder.
 */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

/**
 * Stable model-facing handle for one exact request image. Identity comes from
 * the occurrence's own durable reference: request versions are prepared per
 * attachment id, so one shared version may serve occurrences whose display
 * names differ.
 * @param ref - the occurrence's durable normalized attachment.
 * @param version - exact request-image dimensions shown beside the text.
 * @param access - optional path resolved for the current tool execution world.
 * @returns attachment handle and request-image dimensions.
 */
export function requestImageHandleText(
  ref: ImageAttachmentRef,
  version: Pick<RequestImageAttachment, 'width' | 'height'>,
  access?: ImageAttachmentAccess,
): string {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  return access === undefined
    ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
    : preview + normalizedAccessText(ref, access)
}

/**
 * Stable per-image placeholder for a request-limit omission.
 * @param ref - durable normalized attachment omitted from this request.
 * @param access - optional provider-resolved path for model tools.
 * @returns identity, normalized metadata, and the available recovery path.
 */
export function offloadedImageText(
  ref: ImageAttachmentRef,
  access?: ImageAttachmentAccess,
): string {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  if (access === undefined) {
    return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
  }
  return `[${identity}${normalizedAccessText(ref, access)}]`
}

/**
 * True when typed model content contains an image block. This is the one image
 * walk shared by every image policy (capability gating, text-only
 * serialization, compaction survey), so a consumer cannot silently diverge.
 * @param content - typed model content blocks.
 * @returns whether any block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image')
}

/**
 * True when typed model content contains a file block.
 * Reads current content on every call without retaining scan results.
 * @param content - typed model content blocks.
 * @returns whether any block is a file.
 */
export function contentHasFile(content: readonly ContentBlock[]): boolean {
  for (const block of content) {
    if (block.type === 'file') return true
  }
  return false
}

/**
 * Stable model-facing handle for one durable file reference: the address of
 * the verbatim stored copy and the instruction to read it on demand. This is
 * the only representation a provider ever receives for a file.
 * @param ref - durable verbatim file reference.
 * @param readonlyPath - execution-world path of the stored copy, when resolvable.
 * @returns deterministic handle text naming the file, its size, and its address.
 */
export function fileHandleText(ref: FileAttachmentRef, readonlyPath: string | undefined): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  if (readonlyPath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** Replace every file occurrence with handle text. */
function replaceFilesWithHandles(
  blocks: readonly ContentBlock[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'file') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: fileHandleText(block.attachment, resolvePath(block.attachment)) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project request file content into deterministic handle text for every model
 * route. Unlike images, no provider receives file blocks natively, so this
 * projection is unconditional in request assembly.
 * @param messages - complete request history.
 * @param resolvePath - resolve one reference's current execution-world read path.
 * @returns the original list without files, otherwise shallow message copies with handle text.
 */
export function projectFilesToText(
  messages: readonly Message[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly Message[]
/**
 * Project file content in mixed durable and request-only inputs.
 * @param messages - complete request inputs.
 * @param resolvePath - resolve a reference's execution-world read path.
 * @returns original inputs without files, otherwise copies with handle text.
 */
export function projectFilesToText(
  messages: readonly RequestMessage[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly RequestMessage[]
export function projectFilesToText(
  messages: readonly RequestMessage[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly RequestMessage[] {
  if (!messages.some(message => contentHasFile(message.content))) return messages
  return messages.map((message) => {
    const content = replaceFilesWithHandles(message.content, resolvePath)
    return content === message.content ? message : { ...message, content }
  })
}

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Visit every image occurrence of typed content in message order.
 * @param content - typed model content blocks.
 * @param visit - called once per occurrence.
 */
function visitImageBlocks(content: readonly ContentBlock[], visit: (block: ImageBlock) => void): void {
  for (const block of content) {
    if (block.type === 'image') visit(block)
  }
}

/** Replace every offloaded occurrence with its placeholder. */
function replaceOffloadedImages(
  blocks: readonly ContentBlock[],
  placeholder: (ref: ImageAttachmentRef) => string,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && block.offloaded === true) {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: placeholder(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project the surface's offloaded occurrences into deterministic text for one
 * request. The offloaded set is a durable surface fact, so every route sends
 * the same set; only the placeholder text is route-owned.
 * @param messages - derived request history.
 * @param placeholder - build the model-visible replacement for one offloaded attachment.
 * @returns the original list when nothing is offloaded, otherwise shallow message copies with placeholders.
 */
export function projectOffloadedImages(
  messages: readonly Message[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly Message[]
/**
 * Project offloaded images in mixed durable and request-only inputs.
 * @param messages - complete request inputs.
 * @param placeholder - replacement text for an offloaded attachment.
 * @returns original messages or shallow copies with placeholders.
 */
export function projectOffloadedImages(
  messages: readonly RequestMessage[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly RequestMessage[]
export function projectOffloadedImages(
  messages: readonly RequestMessage[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly RequestMessage[] {
  return messages.map((message) => {
    const content = replaceOffloadedImages(message.content, placeholder)
    return content === message.content ? message : { ...message, content }
  })
}

/**
 * Number of oldest retained image occurrences one route budget removes, in
 * whole count and byte quanta, once the budget is exceeded. The result depends
 * only on the represented lengths, so every route names the count the same
 * way.
 * @param lengths - represented byte length of every retained occurrence, oldest first.
 * @param budget - count/byte budgets and removal quanta; unbounded when absent.
 * @returns how many leading occurrences to offload.
 */
function offloadedImagePrefixCount(
  lengths: readonly number[],
  budget: Pick<LlmImageRequestBudget, 'maxImages' | 'maxBytes' | 'countQuantum' | 'byteQuantum'>,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = budget.maxImages === undefined ? 0 : Math.max(0, lengths.length - budget.maxImages)
  const excessBytes = budget.maxBytes === undefined ? 0 : Math.max(0, total - budget.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const countQuantum = budget.countQuantum ?? 1
  const byteQuantum = budget.byteQuantum ?? 1
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += imageBytes
    count += 1
  }
  return count
}

/**
 * Number of oldest retained occurrences a route must still offload before a
 * derived request fits its budget at the exact byte length the route sends;
 * zero when the request fits. A route fails with `IMAGE_OFFLOAD_REQUIRED`
 * carrying this count instead of offloading on its own.
 * @param messages - derived request history carrying the surface's `offloaded` marks.
 * @param budget - route representation, budgets, and removal quanta.
 * @param versionBytes - exact request-version byte length of one retained occurrence.
 * @returns how many more leading retained occurrences to offload.
 */
export function requiredImageOffload(
  messages: readonly RequestMessage[],
  budget: Pick<LlmImageRequestBudget, 'representation' | 'maxBytes' | 'maxImages' | 'byteQuantum' | 'countQuantum'>,
  versionBytes: (block: ImageBlock) => number,
): number {
  const lengths: number[] = []
  for (const message of messages) {
    visitImageBlocks(message.content, (block) => {
      if (block.offloaded === true) return
      const bytes = versionBytes(block)
      lengths.push(budget.representation === 'base64' ? base64Length(bytes) : bytes)
    })
  }
  return offloadedImagePrefixCount(lengths, budget)
}

/** Replace every image occurrence for a text-only model. */
function replaceImagesForTextModel(blocks: readonly ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: textOnlyImageText(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project request image content into deterministic text for an exact text-only model.
 * @param messages - complete request history.
 * @returns the original list without images, otherwise shallow message copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[]
/**
 * Project image content in mixed durable and request-only inputs for a text-only model.
 * @param messages - complete request inputs.
 * @returns original inputs without images, otherwise copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly RequestMessage[]): readonly RequestMessage[]
export function projectImagesForTextModel(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  if (!messages.some(message => contentHasImage(message.content))) return messages
  return messages.map((message) => {
    const content = replaceImagesForTextModel(message.content)
    return content === message.content ? message : { ...message, content }
  })
}

/** Request messages and tools after one route's tool update projection. */
export interface ProjectedToolUpdates {
  /** History with only the developer updates supported by this route and declaration series. */
  readonly messages: readonly RequestMessage[]
  /** Provider declarations, including deferred and retained definitions when supported. */
  readonly tools: readonly ToolSchema[] | undefined
}

function withoutDeveloperMessages(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  const retained = messages.filter(message => message.role !== 'developer')
  return retained.length === messages.length ? messages : retained
}

function toolDeclarations(
  tools: readonly ToolSchema[] | undefined,
  mode: ToolUpdate,
  history: ToolHistory,
): Map<string, ToolSchema> {
  const declarations = new Map(history.tools.map(tool => [tool.name, tool]))
  for (const update of history.updates) {
    for (const tool of update.additions) {
      if (!declarations.has(tool.name)) {
        // Later additions activate these definitions at their recorded position.
        declarations.set(tool.name, { ...tool, deferLoading: true })
      }
    }
  }

  switch (mode) {
    case 'in-history':
      // Removal blocks disable tools without discarding their historical definitions.
      return declarations
    case 'addition-only': {
      // Without removal support, the declaration list must omit inactive tools.
      const activeNames = new Set(tools?.map(tool => tool.name))
      for (const name of declarations.keys()) {
        if (!activeNames.has(name)) declarations.delete(name)
      }
      return declarations
    }
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(mode)
  }
}

/**
 * Construct provider declarations from session-folded history without changing logged active tools.
 * Unsupported routes and incomplete history use current declarations without developer updates.
 * Explicitly deferred baseline tools become available only after their first retained addition.
 * @param messages - complete request inputs, or the prefix selected for an auxiliary call.
 * @param tools - currently active tool schemas.
 * @param toolUpdate - the resolved route's update mode.
 * @param history - immutable state folded from committed headers and developer messages.
 * @returns provider declarations and the corresponding filtered history.
 */
export function projectToolUpdates(
  messages: readonly RequestMessage[],
  tools: readonly ToolSchema[] | undefined,
  toolUpdate: ToolUpdate | undefined,
  history?: ToolHistory,
): ProjectedToolUpdates {
  if (toolUpdate === undefined) {
    // Unsupported routes need immediately available tools and no update messages.
    let immediateTools = tools
    if (tools?.some(tool => tool.deferLoading === true)) {
      immediateTools = tools.map(({ deferLoading: _loading, ...tool }) => tool)
    }
    return { messages: withoutDeveloperMessages(messages), tools: immediateTools }
  }

  if (history === undefined) {
    // Current schemas alone cannot resolve definitions referenced by past updates.
    return { messages: withoutDeveloperMessages(messages), tools }
  }
  const messageIds = new Set(messages.flatMap(message => message.role === 'developer' ? [message.id] : []))
  if (history.updates.some(update => !messageIds.has(update.messageId))) {
    // An auxiliary prefix may omit updates needed to activate historical declarations.
    return { messages: withoutDeveloperMessages(messages), tools }
  }

  const declarations = toolDeclarations(tools, toolUpdate, history)
  const updateIds = new Set(history.updates.map(update => update.messageId))
  // Deferred baseline tools still need their first addition to become available.
  const offered = new Set(history.tools.filter(tool => !tool.deferLoading).map(tool => tool.name))
  const projectedMessages: RequestMessage[] = []
  for (const message of messages) {
    if (message.role !== 'developer') {
      projectedMessages.push(message)
      continue
    }
    // Earlier declaration series do not govern the current tool set.
    if (!updateIds.has(message.id)) continue

    const content = message.content.filter((block) => {
      switch (block.type) {
        case 'tool-addition':
          // Only declared tools that are not already available need activation.
          if (!declarations.has(block.toolName) || offered.has(block.toolName)) return false
          offered.add(block.toolName)
          return true
        case 'tool-removal':
          // Addition-only routes cannot deactivate a tool through history.
          if (toolUpdate !== 'in-history') return false
          return offered.delete(block.toolName)
        default:
          // Other core and plugin-defined blocks retain their content and order.
          return true
      }
    })
    if (content.length === 0) continue
    if (content.length === message.content.length) {
      projectedMessages.push(message)
    } else {
      projectedMessages.push({ ...message, content })
    }
  }

  const unchanged = projectedMessages.length === messages.length
    && projectedMessages.every((message, index) => message === messages[index])
  return {
    messages: unchanged ? messages : projectedMessages,
    tools: [...declarations.values()],
  }
}
