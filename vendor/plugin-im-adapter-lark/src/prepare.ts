/**
 * The upload stage of the Lark / Feishu adapter (`prepare`).
 *
 * Media is key-based, not URL-based: a message carries an `image_key` / `file_key` that only the application that
 * uploaded the bytes may send. Every `img`/`audio`/`video`/`file` of the element tree therefore reaches this stage as a
 * `ResourceRef` placeholder, and `prepare()` calls {@link uploadResource} once per distinct `(scope, kind, src)`:
 *
 * - `kind: 'image'` → `POST /im/v1/images` (`image_type: message`), at most 10 MB.
 * - everything else → `POST /im/v1/files` with the `file_type` of {@link uploadFileType}, at most 30 MB.
 *
 * ## `file_type` (the one platform rule with no default)
 *
 * The platform rejects a `file_type` that does not match the message kind it is sent as, so the mapping has to
 * agree with what the mode decided in `assemble`: both read the same evidence, the extension of `meta.name ?? src`.
 *
 * - `audio` → `opus` (playable as a voice message), else `stream` + `downgraded`.
 * - `video` → `mp4` (playable as a video message), else `stream` + `downgraded`.
 * - `file` → `pdf` / `doc` / `xls` / `ppt` by MIME type, then by extension, else `stream`.
 * - `image` → no `file_type`; the image route owns the format.
 *
 * The MIME type a `PrepareContext.fetch` discovered is only consulted for the document kinds, where it cannot
 * disagree with the message kind: choosing `opus`/`mp4` from a MIME type the mode never saw (the mode only reads the
 * extension) would upload a key whose kind does not match the message about to carry it, which the platform refuses
 * with "file type mismatch". The adapter does not transcode, so a media kind the platform cannot play is published as a
 * plain file; the modes report that as `RenderReport.moved` (`not-opus` / `not-mp4`) while rendering, and this stage
 * repeats the verdict in {@link LarkUploadExtra.downgraded}.
 *
 * ## Caching
 *
 * A Lark key belongs to the application (hence {@link import('./bot.ts').LarkBot.resourceScope} returns the app id) and
 * has no documented expiry — unlike a QQ `file_info` — so this stage reports no `expiresAt` and the core cache keeps
 * the key until its LRU bound evicts it. Re-rendering a streamed or edited message therefore uploads nothing twice.
 *
 * ## Errors
 *
 * What this stage can see itself (empty bytes, a route's size limit) is raised as the core `PlatformError`, so a
 * caller can re-render instead of retrying. A failure of the platform itself is the REST client's `LarkApiError`,
 * unchanged: the core pipeline classifies `sendPayload`/`editPayload`/`deletePart` but not `upload`, so whoever
 * reports the failure into the taxonomy calls `bot.classify` on it.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/prepare
 */

import {
  PlatformError, type PrepareContext, type ResolvedResource, type ResourceKind, type ResourceRef,
} from '@deepseek-ai/cordis-plugin-im-core'
import type { LarkFileType } from './api/client.ts'
import type { LarkBot } from './bot.ts'

/** Bytes one image may have (`/im/v1/images`). */
export const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024
/** Bytes one file, audio or video may have (`/im/v1/files`). */
export const FILE_LIMIT_BYTES = 30 * 1024 * 1024

/** The upload route a resource takes: the image route or the file route. */
export type LarkUploadRoute = 'image' | 'file'

/** The classification of one resource against the two upload routes. */
export interface LarkUploadKind {
  route: LarkUploadRoute
  /** `file_type` of the file route; absent on the image route. */
  fileType?: LarkFileType
  /** An audio/video the platform cannot play natively, uploaded as a plain file. */
  downgraded: boolean
}

/** What {@link uploadResource} resolved, beyond the platform key (`ResolvedResource.extra`). */
export interface LarkUploadExtra {
  route: LarkUploadRoute
  /** Element kind the resource was rendered from. */
  kind: ResourceKind
  /** `file_type` the bytes went up with; absent for an image. */
  fileType?: LarkFileType
  /** The platform cannot play this audio/video, so it was uploaded as a plain file. */
  downgraded: boolean
}

/** MIME types of the file route that have their own `file_type`. */
const DOCUMENT_MIME: Readonly<Record<string, LarkFileType>> = Object.assign(
  Object.create(null) as Record<string, LarkFileType>,
  {
    'application/pdf': 'pdf' as const,
    'application/msword': 'doc' as const,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'doc' as const,
    'application/vnd.ms-excel': 'xls' as const,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xls' as const,
    'application/vnd.ms-powerpoint': 'ppt' as const,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt' as const,
  },
)

/** Extensions of the file route that have their own `file_type`. */
const DOCUMENT_EXTENSION: Readonly<Record<string, LarkFileType>> = Object.assign(
  Object.create(null) as Record<string, LarkFileType>,
  {
    pdf: 'pdf' as const,
    doc: 'doc' as const,
    docx: 'doc' as const,
    xls: 'xls' as const,
    xlsx: 'xls' as const,
    ppt: 'ppt' as const,
    pptx: 'ppt' as const,
  },
)

/** File name an image without any name hint goes up as, per MIME type (the platform shows the name in a preview). */
const IMAGE_NAME: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    'image/png': 'image.png',
    'image/jpeg': 'image.jpg',
    'image/gif': 'image.gif',
    'image/webp': 'image.webp',
    'image/bmp': 'image.bmp',
    'image/tiff': 'image.tiff',
    'image/heic': 'image.heic',
  },
)

/**
 * The extension of a resource, from its name hint or its source path.
 *
 * @param ref - the resource being uploaded.
 * @returns a lowercase extension without the dot, or an empty string.
 */
function extensionOf(ref: ResourceRef): string {
  const candidate = ref.meta.name ?? ref.src
  const path = (candidate.split('?')[0] ?? candidate).split('#')[0] ?? candidate
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

/**
 * The MIME type of a resource, normalized: the `ResourceRef` hint first, then the hint a fetch discovered.
 *
 * @param ref - the resource being uploaded.
 * @param hint - MIME type reported by `PrepareContext.fetch`, if any.
 * @returns a lowercase `type/subtype`, or an empty string when nothing is known.
 */
function mimeOf(ref: ResourceRef, hint?: string): string {
  const value = (ref.meta.mime ?? hint ?? '').toLowerCase()
  const semicolon = value.indexOf(';')
  return (semicolon < 0 ? value : value.slice(0, semicolon)).trim()
}

/**
 * Classify one resource into the route and `file_type` the upload takes.
 *
 * `image` → the image route. `audio` → `opus` when the source is OPUS, else `stream`. `video` → `mp4` when the source
 * is MP4, else `stream`. `file` → the document `file_type` of its MIME type or extension, else `stream`. A media kind
 * the platform cannot play is uploaded as a plain file and reported as {@link LarkUploadKind.downgraded}.
 *
 * @param ref - the resource being uploaded.
 * @param hint - MIME type reported by `PrepareContext.fetch` (a `data:`/base64 source may carry none of its own).
 * @returns the route, the `file_type` of the file route and whether the media was downgraded to a plain file.
 */
export function uploadFileType(ref: ResourceRef, hint?: string): LarkUploadKind {
  if (ref.kind === 'image') return { route: 'image', downgraded: false }
  const extension = extensionOf(ref)
  if (ref.kind === 'audio') {
    // The mode decided `msg_type: audio` from this same extension (see the module comment), so it decides the
    // `file_type` too: a key uploaded as `opus` may only be carried by an `audio` message.
    return extension === 'opus'
      ? { route: 'file', fileType: 'opus', downgraded: false }
      : { route: 'file', fileType: 'stream', downgraded: true }
  }
  if (ref.kind === 'video') {
    return extension === 'mp4'
      ? { route: 'file', fileType: 'mp4', downgraded: false }
      : { route: 'file', fileType: 'stream', downgraded: true }
  }
  const fileType = DOCUMENT_MIME[mimeOf(ref, hint)] ?? DOCUMENT_EXTENSION[extension] ?? 'stream'
  return { route: 'file', fileType, downgraded: false }
}

/**
 * The name one resource goes up with: its own hint, then the name the fetch discovered, then a kind-based default
 * (the platform requires one and shows it to the recipient).
 *
 * @param ref - the resource being uploaded.
 * @param fetchedName - `name` reported by `PrepareContext.fetch`, if any.
 * @param mime - MIME type of the bytes, for the extension of the default image name.
 * @returns the file name of the multipart part.
 */
function nameOf(ref: ResourceRef, fetchedName: string | undefined, mime: string): string {
  const hint = ref.meta.name?.trim() || fetchedName?.trim()
  if (hint) return hint
  if (ref.kind === 'image') return IMAGE_NAME[mime] ?? 'image.png'
  const extension = extensionOf(ref)
  return extension ? `${ref.kind}.${extension}` : ref.kind
}

/**
 * Upload one resource and hand its platform key to the core cache.
 *
 * The core calls this only on a cache miss, bounds the concurrency and cancels sibling uploads through the one signal
 * of `ctx`, so this function only has to honour `ctx.signal` and report what it uploaded.
 *
 * @param bot - the adapter (its REST client and id).
 * @param ref - resource to upload (kind, source and the name/MIME hints of the element).
 * @param _scope - resource scope; {@link import('./bot.ts').LarkBot.resourceScope} returns the application, which is
 * what the platform keys by, so it does not address the request itself (it only separates cache entries).
 * @param ctx - prepare context: `fetch` for the bytes, cancellation.
 * @returns the resolved platform key and the {@link LarkUploadExtra} classification of the upload.
 * @throws PlatformError `limit` when the bytes exceed the route's limit, `invalid` when they are empty, so the caller
 * sees a content problem instead of a retried request.
 */
export async function uploadResource(
  bot: LarkBot,
  ref: ResourceRef,
  _scope: string,
  ctx: PrepareContext,
): Promise<ResolvedResource> {
  const fetched = await ctx.fetch(ref.src, ctx.signal)
  ctx.signal.throwIfAborted()
  const mime = mimeOf(ref, fetched.mime)
  const kind = uploadFileType(ref, fetched.mime)
  const name = nameOf(ref, fetched.name, mime)
  const data = fetched.data
  const limit = kind.route === 'image' ? IMAGE_LIMIT_BYTES : FILE_LIMIT_BYTES
  if (!data.byteLength) {
    throw new PlatformError('invalid', `${bot.id}: the ${ref.kind} "${ref.src}" has no bytes to upload`, { published: 'no' })
  }
  if (data.byteLength > limit) {
    throw new PlatformError(
      'limit',
      `${bot.id}: the ${ref.kind} "${ref.src}" is ${data.byteLength} bytes and the ${kind.route} route accepts ${limit}`,
      { published: 'no' },
    )
  }
  const key = kind.route === 'image'
    ? await bot.api.uploadImage(data, name, mime || undefined, ctx.signal)
    : await bot.api.uploadFile(data, name, kind.fileType ?? 'stream', ctx.signal, ref.meta.duration)
  const extra: LarkUploadExtra = {
    route: kind.route,
    kind: ref.kind,
    ...kind.fileType === undefined ? {} : { fileType: kind.fileType },
    downgraded: kind.downgraded,
  }
  return { key, extra }
}
