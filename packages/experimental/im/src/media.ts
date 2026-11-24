/**
 * Platform-neutral media admission: media references of stored messages, stable ids `#<seq>.<n>`, and bounded download
 * through the core resource fetcher (`bot` resources and platform URLs) into attachments.
 *
 * Identifiers are per chat and stable for the lifetime of the stored message: `#<seq>.<n>` names the *n*-th media
 * element of the message stored with that `seq`, so a model that saw `[图片 #12.1]` can ask for it later with
 * `im_read_image { id: '12.1' }` even after the record was paged out of the transcript.
 *
 * Images are admitted as normalized image blocks; every other kind (`file`, `audio`, `video`) is admitted as the exact
 * bytes of a durable verbatim file, which request assembly projects to a handle naming the stored copy and
 * `im_read_file` materializes in the caller's own filesystem.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createResourceFetcher, ResourceTooLargeError, type Element, type PrepareContext } from '@deepseek-ai/cordis-plugin-im-core'
import { AttachmentId, type AttachmentStore, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { splitKey, type ImApi, type ImChatKey, type ImConfig, type ImMessage, type ImMessageKey } from './api.ts'
import { ImError } from './error.ts'
import { hasUnreadForward } from './intake.ts'
import { admitMediaSource, systemHostResolver, type HostResolver } from './media-source.ts'

/** Kind of a downloadable media element: the image kind is normalized, every other kind is kept verbatim. */
export type ImMediaKind = 'image' | 'file' | 'audio' | 'video'

/** One media element (`img` / `file` / `audio` / `video`) of a stored message, in content order. */
export interface ImMediaRef {
  message: ImMessageKey
  chat: ImChatKey
  seq: number
  /** 1-based index within the message. */
  index: number
  kind: ImMediaKind
  src: string
  name?: string
  mime?: string
}

/** Outcome of downloading one reference. */
export interface ImMediaItem {
  ref: ImMediaRef
  /** Present when the reference was admitted as an image. */
  image?: ImageBlock
  /** Present when the reference was admitted as a verbatim file (`file`, `audio` and `video` kinds). */
  file?: FileBlock
  mime?: string
  bytes?: number
  /** Why the item was not admitted (`too-large`, `limit`, `disabled`, `unavailable`, platform error text …). */
  skipped?: string
}

/** Outcome of resolving one media id as a file read (`im_read_file`). */
export interface ImMediaFileItem extends ImMediaItem {
  /** Exact bytes of the admitted file, so the caller can materialize them in its own execution world. */
  data?: Uint8Array
}

/** Media tag → admission kind. Only these tags carry downloadable bytes. */
const MEDIA_KINDS: Readonly<Partial<Record<Element['type'], ImMediaKind>>> = {
  img: 'image', file: 'file', audio: 'audio', video: 'video',
}

/** Model-facing noun of each kind. */
const KIND_LABELS: Readonly<Record<ImMediaKind, string>> = {
  image: '图片', file: '文件', audio: '语音', video: '视频',
}

/** Attribute bag of any element (`TypedElement` attrs are a union of per-tag shapes). */
function attrsOf(node: Element): Record<string, unknown> {
  return node.attrs
}

/** Display name a media element carries: `alt` for images, `name` for the other kinds. */
function displayName(kind: ImMediaKind, attrs: Record<string, unknown>): string | undefined {
  const value = kind === 'image' ? attrs.alt : attrs.name
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Media types the attachment service stores for images ({@link ImageMediaType}). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const satisfies
  readonly ImageMediaType[]

/**
 * Stored JSON form of one durable image reference, read back from a tool result: the values `ctx.attachments` wrote,
 * validated so a corrupted record cannot claim an image the provider would fail to fetch.
 */
export const imageAttachmentSchema = z.object({
  attachmentId: z.string().transform(AttachmentId),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.exactOptional(z.string()),
  originalDimensions: z.exactOptional(z.object({ width: z.number(), height: z.number() })),
})

/**
 * Media references of a message in content order.
 * @param message - the stored message to walk.
 * @returns one reference per media element, numbered 1-based in the order the labels appear in the text.
 */
export function mediaRefs(message: ImMessage): ImMediaRef[] {
  const refs: ImMediaRef[] = []
  const visit = (node: Element) => {
    const kind = mediaKindOf(node)
    if (kind) refs.push(mediaRefAt(message, node, kind, refs.length + 1))
    for (const child of node.children) visit(child)
  }
  for (const child of message.content.children) visit(child)
  return refs
}

/**
 * Admission kind of a media element (`img` / `file` / `audio` / `video`), undefined for everything else.
 * @param node - any element of a message content tree.
 * @returns its media kind, or undefined when the element carries no downloadable bytes.
 */
export function mediaKindOf(node: Element): ImMediaKind | undefined {
  return MEDIA_KINDS[node.type]
}

/**
 * Reference of one media element numbered `index` (1-based) within its message. The formatter walks the content
 * itself and numbers as it goes, so the label it shows and the reference `im_read_image` resolves always agree.
 * @param message - the message the element belongs to.
 * @param node - the media element.
 * @param kind - its admission kind ({@link mediaKindOf}).
 * @param index - its 1-based position among the message's media elements.
 * @returns the reference (source, display name and chat identity included).
 */
export function mediaRefAt(message: ImMessage, node: Element, kind: ImMediaKind, index: number): ImMediaRef {
  const attrs = attrsOf(node)
  const name = displayName(kind, attrs)
  return {
    message: message.key,
    chat: message.chat.key,
    seq: message.seq,
    index,
    kind,
    src: typeof attrs.src === 'string' ? attrs.src : '',
    ...name ? { name } : {},
  }
}

/** Collapse a display name into one bounded line, so a label never breaks the message text. */
function cleanName(name: string | undefined): string | undefined {
  const collapsed = name?.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  const chars = Array.from(collapsed)
  return chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : collapsed
}

/**
 * Stable model-facing label: `[图片 #12.1]`, `[文件 #12.2 report.pdf]` …
 * @param ref - the media reference to label.
 * @returns the label the transcript shows and the model later quotes back to read the element.
 */
export function mediaLabel(ref: ImMediaRef): string {
  const id = `#${ref.seq}.${ref.index}`
  const name = cleanName(ref.name)
  return `[${KIND_LABELS[ref.kind]} ${id}${name ? ` ${name}` : ''}]`
}

/** `#12.1`, `12.1` or a bare `12` (first media element of the message). */
const MEDIA_ID = /^#?(\d+)(?:\.(\d+))?$/

/**
 * Parse `#12.1` / `12.1` back into seq and index.
 * @param id - the model-supplied media id; a bare `12` names the first media element of message 12.
 * @returns the resolved seq and 1-based index, or undefined when the text is not a media id.
 */
export function parseMediaId(id: string): { seq: number; index: number } | undefined {
  const match = MEDIA_ID.exec(id.trim())
  if (!match) return undefined
  const index = match[2] === undefined ? 1 : Number(match[2])
  return index >= 1 ? { seq: Number(match[1]), index } : undefined
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]

function matchesBytes(data: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/**
 * Identify a raster format the attachment service accepts from its bytes (never from a name or header).
 * @param data - complete downloaded resource bytes.
 * @returns the detected media type, or undefined for any other content.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (matchesBytes(data, 0, PNG)) return 'image/png'
  if (matchesBytes(data, 0, JPEG)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

/** Reason carried by a cancelled caller signal (never invented: the caller's own alarm wins). */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('The media admission was aborted')
}

/** What {@link ImMediaStore} needs besides its context and configuration. */
export interface ImMediaStoreOptions {
  /** Address lookup of an http(s) source's host; the system resolver by default. */
  resolveHost?: HostResolver
}

/**
 * Downloads the media of stored messages, bounded by `config.media`: refuses a source a received message may not make
 * this host fetch ({@link admitMediaSource}), fetches the rest, bounds their bytes, and keeps the bytes as a durable
 * attachment — normalized for an image, verbatim for every other kind — so a later `im_read_image` / `im_read_file`
 * resolves the same element.
 */
export class ImMediaStore {
  /** `createResourceFetcher` closure, built on first use (it reads `ctx.http` per call). */
  private fetcher: PrepareContext['fetch'] | undefined
  private readonly resolveHost: HostResolver

  constructor(readonly ctx: Context, readonly config: ImConfig, options: ImMediaStoreOptions = {}) {
    this.resolveHost = options.resolveHost ?? systemHostResolver
  }

  /**
   * Download the references (bounded by `config.media.maxItems` / `maxBytes`; disabled ⇒ all skipped).
   * Never throws for a reference that cannot be admitted: the item reports why in `skipped`.
   * @param refs - references in the order their labels appear in the transcript.
   * @param signal - cancellation of the caller (delivery/turn end).
   * @returns one outcome per reference, in the same order.
   */
  async admit(refs: readonly ImMediaRef[], signal?: AbortSignal): Promise<ImMediaItem[]> {
    const limits = this.config.media
    if (!limits.download) return refs.map(ref => ({ ref, skipped: 'disabled' }))
    const items: ImMediaItem[] = []
    let admitted = 0
    for (const ref of refs) {
      if (signal?.aborted) throw abortReason(signal)
      if (admitted >= limits.maxItems) {
        items.push({ ref, skipped: 'limit' })
        continue
      }
      admitted += 1
      items.push(await this.admitAs(ref, signal, ref.kind === 'image' ? 'image' : 'file'))
    }
    return items
  }

  /**
   * Resolve one stable id within a chat as an image (`im_read_image`).
   * @param chat - the chat the id was shown in.
   * @param id - `#12.1`, `12.1` or `12` (the first media element of message 12).
   * @param signal - cancellation of the calling turn.
   * @param allow - optional predicate checking whether the owning message is readable by the caller.
   * @returns the admission outcome of exactly that media element, as an image.
   */
  async read(
    chat: ImChatKey,
    id: string,
    signal?: AbortSignal,
    allow?: (message: ImMessage) => boolean,
  ): Promise<ImMediaItem> {
    const ref = await this.elementAt(chat, id, allow, signal)
    if (ref.kind !== 'image') return { ref, skipped: 'unsupported' }
    if (!this.config.media.download) return { ref, skipped: 'disabled' }
    return this.admitAs(ref, signal, 'image')
  }

  /**
   * Resolve one stable id within a chat as a stored file (`im_read_file`): every kind is kept verbatim, so an image
   * label resolves to its original bytes as well as a `[文件 #12.1]` label does.
   * @param chat - the chat the id was shown in.
   * @param id - `#12.1`, `12.1` or `12` (the first media element of message 12).
   * @param signal - cancellation of the calling turn.
   * @param allow - optional predicate checking whether the owning message is readable by the caller.
   * @returns the admission outcome of exactly that media element, with the exact bytes a caller stages for the model.
   */
  async readFile(
    chat: ImChatKey,
    id: string,
    signal?: AbortSignal,
    allow?: (message: ImMessage) => boolean,
  ): Promise<ImMediaFileItem> {
    const ref = await this.elementAt(chat, id, allow, signal)
    if (!this.config.media.download) return { ref, skipped: 'disabled' }
    return await this.admitAs(ref, signal, 'file')
  }

  /**
   * The media element one stable id names within a chat (both read tools resolve their id here).
   * @param chat - the chat the id was shown in.
   * @param id - `#12.1`, `12.1` or `12` (the first media element of message 12).
   * @param allow - optional predicate checking whether the owning message is readable by the caller.
   * @param signal - cancellation of the calling turn, forwarded to any platform forward expansion.
   * @returns that element's reference.
   */
  private async elementAt(
    chat: ImChatKey,
    id: string,
    allow?: (message: ImMessage) => boolean,
    signal?: AbortSignal,
  ): Promise<ImMediaRef> {
    const parsed = parseMediaId(id)
    if (!parsed) throw new ImError('access', `"${id}" is not a media id such as 12.1.`)
    const stored = this.messageAt(chat, parsed.seq)
    if (!stored) throw new ImError('access', `Chat ${chat} has no stored message #${parsed.seq}.`)
    if (allow !== undefined && !allow(stored)) {
      throw new ImError('access', `Message #${parsed.seq} is outside the threads granted to this session.`)
    }
    const message = await this.expanded(chat, stored, signal)
    const ref = mediaRefs(message).find(ref => ref.index === parsed.index)
    if (!ref) throw new ImError('access', `Message #${parsed.seq} has no media element #${parsed.index}.`)
    return ref
  }

  /**
   * The message as a reader sees it: a merged forward the store holds as a reference gains its entries from one
   * platform read, and that read is what puts the pictures of the forwarded conversation inside the message.
   * @param chat - the chat the message was shown in.
   * @param message - the stored message.
   * @param signal - cancellation of the calling turn.
   * @returns the message, expanded when the platform carries its entries.
   */
  private async expanded(chat: ImChatKey, message: ImMessage, signal?: AbortSignal): Promise<ImMessage> {
    if (!hasUnreadForward(message.content)) return message
    return await this.imOf().readMessage(chat, splitKey(message.key).id, signal)
  }

  /** Stored message with exactly this per-chat seq. */
  private messageAt(chat: ImChatKey, seq: number): ImMessage | undefined {
    const [message] = this.imOf().history.after(chat, seq - 1, 1)
    return message?.seq === seq ? message : undefined
  }

  /** The mounted IM service, required when resolving stored message ids. */
  private imOf(): ImApi {
    const im = this.ctx.get('im')
    if (!im) throw new ImError('unavailable', 'The im service is not available for media reads.')
    return im
  }

  /**
   * Fetch one reference, bound it by `media.maxBytes`, and hand the bytes to the store `as` selects. Every failure is
   * reported as `skipped`; only the caller's own cancellation is rethrown.
   * @param ref - the reference to admit.
   * @param signal - cancellation of the caller.
   * @param as - `image` for a normalized image block, `file` for a durable verbatim file.
   * @returns the admission outcome of that reference.
   */
  private async admitAs(ref: ImMediaRef, signal: AbortSignal | undefined, as: 'image' | 'file'): Promise<ImMediaFileItem> {
    try {
      const fetched = await this.fetch(ref, signal)
      const bytes = fetched.data.byteLength
      if (bytes > this.config.media.maxBytes) return { ref, bytes, skipped: 'too-large' }
      const attachments = this.ctx.get('attachments')
      return as === 'image'
        ? await this.storeImage(ref, fetched, attachments)
        : await this.storeFile(ref, fetched, attachments)
    } catch (error) {
      if (signal?.aborted) throw error
      // A body over `media.maxBytes` is refused while it is read, which is the same outcome as the check above.
      if (error instanceof ResourceTooLargeError) return { ref, skipped: 'too-large' }
      return { ref, skipped: error instanceof Error ? error.message : String(error) }
    }
  }

  /** One downloaded image: sniff the raster format, then keep the normalized bytes as a durable attachment. */
  private async storeImage(
    ref: ImMediaRef,
    fetched: { data: Uint8Array; mime?: string },
    attachments: AttachmentStore | undefined,
  ): Promise<ImMediaItem> {
    const bytes = fetched.data.byteLength
    const mediaType = sniffImageMediaType(fetched.data)
    if (!mediaType) return { ref, ...fetched.mime ? { mime: fetched.mime } : {}, bytes, skipped: 'unsupported' }
    if (!attachments) return { ref, mime: mediaType, bytes, skipped: 'unavailable' }
    const [attachment] = await attachments.saveImages([
      { data: fetched.data, mediaType, ...ref.name ? { name: ref.name } : {} },
    ])
    if (!attachment) return { ref, mime: mediaType, bytes, skipped: 'persistence' }
    return { ref, image: { type: 'image', attachment }, mime: mediaType, bytes }
  }

  /** One downloaded non-image: keep the exact bytes as a durable verbatim file the model reads by path. */
  private async storeFile(
    ref: ImMediaRef,
    fetched: { data: Uint8Array; mime?: string },
    attachments: AttachmentStore | undefined,
  ): Promise<ImMediaFileItem> {
    const bytes = fetched.data.byteLength
    if (!attachments) return { ref, ...fetched.mime ? { mime: fetched.mime } : {}, bytes, skipped: 'unavailable' }
    const attachment = await attachments.saveFile({
      data: fetched.data,
      ...ref.name ? { name: ref.name } : {},
    })
    return {
      ref,
      file: { type: 'file', attachment },
      ...fetched.mime ? { mime: fetched.mime } : {},
      bytes,
      data: fetched.data,
    }
  }

  /**
   * Bytes of a src: `satori:` internal resources, http(s), and inline `data:`/`base64:` forms, refused past
   * `media.maxBytes` while they are read. A `file:` source and an http(s) one on a non-public address are refused
   * before any I/O unless `media.source` accepts them, and a `satori:` one outside the receiving bot's route always is.
   * The fetch then follows no redirect and ends at `media.timeoutMs`, its body included.
   */
  private async fetch(ref: ImMediaRef, signal: AbortSignal | undefined): Promise<{ data: Uint8Array; mime?: string }> {
    const src = ref.src
    await admitMediaSource(src, this.config.media.source, {
      timeout: this.config.media.timeoutMs,
      resolve: this.resolveHost,
      signal,
      ...src.trim().startsWith('satori:') ? { receiver: this.receiver(ref.chat) } : {},
    })
    this.fetcher ??= createResourceFetcher(this.ctx, {
      maxBytes: this.config.media.maxBytes,
      redirect: 'error',
      timeout: this.config.media.timeoutMs,
    })
    return this.fetcher(src, signal ?? new AbortController().signal)
  }

  /**
   * The platform route of the bot that received a chat's messages, which bounds the `satori:` sources they may name.
   * @param chat - the chat the media element belongs to.
   * @returns the bot's platform and self id, or undefined when no mounted bot serves the chat.
   */
  private receiver(chat: ImChatKey): { platform: string; selfId: string } | undefined {
    try {
      const bot = this.ctx.get('im')?.bot(chat)
      return bot === undefined ? undefined : { platform: bot.platform, selfId: bot.selfId }
    } catch (error: unknown) {
      // An unmounted bot is an unknown receiver, whose `satori:` sources are all refused; anything else is a fault.
      if (error instanceof ImError) return undefined
      throw error
    }
  }
}
