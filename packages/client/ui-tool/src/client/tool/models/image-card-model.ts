/** Pure image-card derivation from raw result content and metadata. @module */
import type { AttachmentId, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import { relativizeToCwd, type ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall } from './raw-tool-call.ts'

/**
 * The image-card material one settled call contributes: the display label plus
 * the durable references the attachment slot renders as a gallery.
 *
 * The bytes are not here. `attachmentId` is opaque and provider-owned, so a UI
 * resolves it to a session-authorized URL at render time; this model never parses
 * it nor derives a path from it.
 */
export interface ImageCardModel {
  /** Card label: the read path, shortened the way every other card's is. */
  label: string
  /** The durable images this result returned, in result order. */
  images: readonly { readonly attachment: ImageAttachmentRef }[]
  /**
   * The model-facing envelope text, for the line under the gallery.
   *
   * Taken from the result's own text block rather than the row's flattened
   * result text: an image read's content is `[text envelope, image block]`, and
   * flattening JSON.stringifies the image block, which would print the raw
   * attachment object under the picture — the symptom this card exists to remove.
   */
  text: string
}

/**
 * The persisted `presentationMeta` this card reads: the resolved display path only
 * (the value `read_image` persisted from its target's display path, not the
 * author-typed `file_path` argument).
 *
 * Root calls persist it; a nested call (a read_image dispatched from inside
 * run_code) settles without `meta`, so the card falls back to the call's own
 * `file_path` argument for the label.
 *
 * The attachment reference deliberately does NOT come from here. The settled
 * `content` already carries the image block with its complete reference, so
 * reading the reference from `meta` too would keep two copies of one fact — and a
 * `tools/post-execute` hook that legitimately replaces the result content would
 * leave the stale `meta` copy behind, showing an image the result no longer
 * returns. `path` is the one fact `content` does not carry.
 */
interface ImageMeta {
  path: string
}

/**
 * Whether a wire value is a usable pixel or byte measure.
 * @param value - unvalidated wire value.
 * @returns true when it is a positive integer.
 */
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** The envelope `formatImageReadOutput` writes, matched by shape. */
const IMAGE_ENVELOPE = /^<path>[^\n]*<\/path>\n<type>image<\/type>\n<content>\n[\s\S]*\n<\/content>$/u

/** The media types a durable image block may claim; anything else declines.
 *  Hand-written mirror of `ImageMediaType` from dsh-attachment — the wire
 *  boundary needs a runtime check and feature plugins must not import values
 *  from each other; a new member added there must be added here too, or the
 *  decline point below silently degrades that image to the generic card. */
const IMAGE_MEDIA_TYPES: ReadonlySet<ImageMediaType> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
])

/** Runtime membership check; the cast is safe because the set holds exactly the four members. */
function isImageMediaType(value: string): value is ImageMediaType {
  return IMAGE_MEDIA_TYPES.has(value as ImageMediaType)
}

/**
 * Narrow the persisted metadata, defensively. Every field arrives unvalidated on
 * replay (an obsolete or hand-edited log reaches here), so any mismatch declines
 * to the generic card rather than throwing. An absent `meta` (a nested call
 * persists none) leaves the path to the call's own `file_path` argument.
 *
 * The attachment id is checked for existence only: it is opaque and
 * provider-owned, and consumers must not parse that representation, so
 * pattern-matching the local content-address form would reject a legitimate id
 * minted by an alternative store.
 * @param meta - persisted presentation metadata of unknown shape.
 * @returns the narrowed path, or null when it does not match.
 */
function imageMeta(meta: unknown): ImageMeta | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const { path } = meta as Record<string, unknown>
  if (typeof path !== 'string' || path === '') return null
  return { path }
}

/**
 * Narrow every attachment reference carried by the result's image blocks, in
 * order.
 *
 * The content is the single source of truth for the references: it is what the
 * tool actually returned and what a post-execute hook would replace together
 * with the rest of the content. Every field arrives unvalidated over the wire,
 * so any malformed image block declines to the generic card rather than
 * rendering a partial gallery.
 *
 * The attachment id is checked for existence only — it is opaque and
 * provider-owned, so pattern-matching the local content-address form would reject
 * a legitimate id minted by an alternative store.
 * @param content - the settled result's content blocks.
 * @returns the narrowed references, or null when no valid image block is present.
 */
function imageReferences(content: readonly unknown[]): ImageAttachmentRef[] | null {
  const refs: ImageAttachmentRef[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const { type, attachment } = part as { type?: unknown; attachment?: unknown }
    if (type !== 'image') continue
    if (typeof attachment !== 'object' || attachment === null || Array.isArray(attachment)) return null
    const {
      attachmentId, mediaType, bytes, width, height, name, originalDimensions,
    } = attachment as Record<string, unknown>
    if (typeof attachmentId !== 'string' || attachmentId === '') return null
    if (typeof mediaType !== 'string' || !isImageMediaType(mediaType)) return null
    // Narrowed one at a time: a loop over the three does validate them, but the
    // control-flow analysis does not carry that back to the object below.
    if (!positiveInteger(bytes) || !positiveInteger(width) || !positiveInteger(height)) return null
    if (name !== undefined && typeof name !== 'string') return null
    // The store records input dimensions when normalization downsampled the
    // image; rebuild the pair so a renderer that needs the original size gets
    // it, and decline on a malformed pair like any other field.
    let inputDimensions: ImageAttachmentRef['originalDimensions'] | undefined
    if (originalDimensions !== undefined) {
      if (typeof originalDimensions !== 'object' || originalDimensions === null || Array.isArray(originalDimensions)) return null
      const { width: inputWidth, height: inputHeight } = originalDimensions as Record<string, unknown>
      if (!positiveInteger(inputWidth) || !positiveInteger(inputHeight)) return null
      inputDimensions = { width: inputWidth, height: inputHeight }
    }
    refs.push({
      attachmentId: attachmentId as AttachmentId,
      mediaType,
      bytes,
      width,
      height,
      ...name === undefined ? {} : { name },
      ...inputDimensions === undefined ? {} : { originalDimensions: inputDimensions },
    })
  }
  return refs.length > 0 ? refs : null
}

/**
 * Read the text of every text block of a settled image result, joined in order.
 *
 * The envelope is one of them; a post-execute hook that appends further text
 * blocks keeps them visible under the gallery instead of being dropped. The
 * envelope shape is still the recognition gate: a result without it is not a
 * well-formed image read and declines.
 * @param content - the settled result's content blocks.
 * @returns the joined text, or null when no envelope-shaped block is present.
 */
function imageTexts(content: readonly { type: string; text?: string }[]): string | null {
  const parts: string[] = []
  let sawEnvelope = false
  for (const part of content) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue
    if (IMAGE_ENVELOPE.test(part.text)) sawEnvelope = true
    parts.push(part.text)
  }
  return sawEnvelope && parts.length > 0 ? parts.join('\n') : null
}

/**
 * Whether the content carries only blocks the card consumes.
 *
 * `ContentBlock` is a merge-extensible union, so a post-execute hook could
 * append a block of a type this card does not render (reasoning, an extension
 * type, or a non-object). Rendering the card anyway would silently hide that
 * block, so anything beyond a well-formed text or image object declines to the
 * generic card, which shows the flattened content.
 * @param content - the settled result's content blocks.
 * @returns true when every block is a text or image object with usable fields.
 */
function fullyRendered(content: readonly unknown[]): boolean {
  return content.every((part) => {
    if (typeof part !== 'object' || part === null) return false
    const { type, text } = part as { type?: unknown; text?: unknown }
    return type === 'image' || (type === 'text' && typeof text === 'string')
  })
}

/**
 * Derive a settled image card after validating the call head, persisted
 * metadata (or its argument fallback), and the model-facing image envelope.
 *
 * The card is result-side only: a call carries no content until `execute`
 * returns, so a running `read_image` has none and this returns null for it.
 * Both root and nested calls settle as ToolResultNode; the nested one (a
 * read_image dispatched from inside run_code) persists no presentationMeta, so
 * its label falls back to the call's own `file_path` argument.
 * @param block - running or settled Tool block.
 * @param sessionCwd - the session workspace root; a workspace-rooted absolute
 *   path label displays relative to it. Absent leaves the path as authored.
 * @param home - host account home; a leftover POSIX home path displays as `~`.
 * @returns the image-card props, or null for the generic path.
 */
export function imageCardModel(
  block: ToolCallBlock,
  sessionCwd?: string,
  home?: string,
): ImageCardModel | null {
  // Result-side only: a running call is not a ToolResultNode and carries no
  // content, so it has no card here.
  if (!('kind' in block) || block.isError) return null
  const call = parsedToolCall(block)
  if (call?.name !== 'read_image') return null
  const { file_path: filePath } = call.args
  if (typeof filePath !== 'string' || filePath.trim() === '') return null
  // The label path: root calls persist it in presentationMeta; a nested call
  // (dispatched from inside run_code) persists none, so its own file_path
  // argument fills the label. A root call with missing or malformed meta
  // declines — malformed tool data falls back to the generic card, which shows
  // the flattened content rather than an author-typed path.
  const metaPath = imageMeta(block.meta)?.path
  const path = metaPath ?? (block.parentCallId !== undefined ? filePath : null)
  if (path === null) return null
  // The card renders only text and image blocks; a block of any other type must
  // not be silently hidden, so the whole card declines to the generic form.
  if (!fullyRendered(block.content)) return null
  // The references come from the result's own image blocks, the single source of
  // truth; `meta` contributes only the path, which the content does not carry.
  const refs = imageReferences(block.content)
  if (refs === null) return null
  const text = imageTexts(block.content)
  if (text === null) return null
  return {
    label: abbreviateHomePath(relativizeToCwd(path, sessionCwd), home),
    images: refs.map(ref => ({ attachment: ref })),
    text,
  }
}
