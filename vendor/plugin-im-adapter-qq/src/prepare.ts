/**
 * The upload stage of the QQ official bot: `POST /v2/{groups|users}/{id}/files`.
 *
 * Media cannot be sent inline. Every `img`/`audio`/`video`/`file` of the element tree reaches this stage as a
 * `ResourceRef`, and `prepare()` calls {@link uploadResource} once per distinct `(scope, kind, src)`:
 *
 * - A remote `http(s)` source goes up as the `url` field — the platform downloads and re-hosts it, which is also why
 * only registered hosts are accepted (`40054010`).
 * - Any other source (`data:`, `base64:`, a `satori:` internal URL, a local file) is fetched through
 * `PrepareContext.fetch` and sent as base64 `file_data`.
 * - The answer is a `file_info` key, not a URL: it is only valid in the chat it was uploaded for, which is why the
 * resource scope of this adapter is the chat id. The core caches it per
 * `(adapter, scope, kind, sha256(src))` until `expiresAt`, which this stage derives from the platform's `ttl`, so a
 * re-rendered or streamed message uploads nothing twice.
 *
 * Two platform restrictions shape {@link uploadFileType}: `file_type: 3` is **voice, SILK only** and `file_type: 2` is
 * **MP4 only**. v1 does not transcode, so any other audio/video goes up as a plain file (`file_type: 4`) and
 * arrives as a file card; the resolved resource reports that in {@link QqUploadExtra.downgraded} for the send stage.
 * The `prepare` stage has no `RenderReport` of its own — `ResolvedResource.extra` is the only
 * channel it has to hand facts to `serialize`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/prepare
 */

import { PlatformError, type PrepareContext, type ResolvedResource, type ResourceKind, type ResourceRef } from '@deepseek-ai/cordis-plugin-im-core'
import { type QqAddress, type QqFileRequest, parseChatId } from './api.ts'
import type { QQBot } from './bot.ts'

/** `file_type` of the  upload route: 1 image, 2 video (MP4), 3 voice (SILK), 4 file. */
export type QqFileType = QqFileRequest['file_type']

/** What {@link uploadResource} resolved, beyond the platform key (`ResolvedResource.extra`). */
export interface QqUploadExtra {
  /** `file_type` the upload was made with; a `msg_type: 7` message carries the resulting `file_info`. */
  fileType: QqFileType
  /** Element kind the resource was rendered from. */
  kind: ResourceKind
  /** The media was uploaded as a plain file because the platform cannot take this audio/video kind . */
  downgraded: boolean
}

/** The classification of one resource against the upload route . */
export interface QqUploadKind {
  fileType: QqFileType
  downgraded: boolean
}

/** Hosted MIME types the platform takes natively: SILK voice and MP4 video . */
const NATIVE_MIME: Readonly<Record<string, { audio: boolean; video: boolean }>> = {
  'audio/silk': { audio: true, video: false },
  'audio/x-silk': { audio: true, video: false },
  'application/silk': { audio: true, video: false },
  'video/mp4': { audio: false, video: true },
}

/** Whether a src is fetched by the platform itself (`url`) instead of being uploaded as bytes (`file_data`). */
export function isRemoteSource(src: string) {
  return /^https?:\/\//i.test(src)
}

/**
 * The MIME type of a resource, normalized: the `ResourceRef` hint first, then the hint a fetch discovered.
 *
 * @param ref - the resource being uploaded.
 * @param hint - MIME type reported by `PrepareContext.fetch`, if any.
 * @returns a lowercase `type/subtype`, or an empty string when nothing is known.
 */
function mimeOf(ref: ResourceRef, hint?: string) {
  const value = (ref.meta.mime ?? hint ?? '').toLowerCase()
  const semicolon = value.indexOf(';')
  return (semicolon < 0 ? value : value.slice(0, semicolon)).trim()
}

/**
 * The file extension of a resource, from its name hint or its source path.
 *
 * @param ref - the resource being uploaded.
 * @returns a lowercase extension without the dot, or an empty string.
 */
function extensionOf(ref: ResourceRef) {
  const candidate = ref.meta.name ?? ref.src
  const path = (candidate.split('?')[0] ?? candidate).split('#')[0] ?? candidate
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

/**
 * Classify one resource into the `file_type` the upload route takes.
 *
 * `image` → 1. `video` → 2 when it is MP4, else 4. `audio` → 3 only when it is SILK, else 4. `file` → 4. A media
 * kind the platform cannot take natively is uploaded as a file and reported as {@link QqUploadKind.downgraded}, since
 * v1 does not transcode.
 *
 * @param ref - the resource being uploaded.
 * @param hint - MIME type reported by `PrepareContext.fetch` (a `data:`/base64 source may carry none of its own).
 * @returns the `file_type` and whether the media was downgraded to a plain file.
 */
export function uploadFileType(ref: ResourceRef, hint?: string): QqUploadKind {
  const mime = mimeOf(ref, hint)
  const native = NATIVE_MIME[mime]
  const extension = extensionOf(ref)
  switch (ref.kind) {
    case 'image':
      return { fileType: 1, downgraded: false }
    case 'video':
      return native?.video || extension === 'mp4'
        ? { fileType: 2, downgraded: false }
        : { fileType: 4, downgraded: true }
    case 'audio':
      return native?.audio || extension === 'silk'
        ? { fileType: 3, downgraded: false }
        : { fileType: 4, downgraded: true }
    default:
      return { fileType: 4, downgraded: false }
  }
}

/**
 * The chat an upload is scoped to; the scope is the self-describing chat id of (`group:<id>` / `user:<id>`).
 *
 * @param scope - `QQBot.resourceScope()` output.
 * @returns the parsed address.
 * @throws PlatformError `invalid` when the scope is not a group/C2C chat id, so the core reports a broken target
 * instead of retrying a request that can never succeed.
 */
function addressOf(scope: string): QqAddress {
  try {
    return parseChatId(scope)
  } catch (error) {
    throw new PlatformError('invalid', `qq: the resource scope must be a chat id — ${(error as Error).message}`, {
      published: 'no',
      cause: error,
    })
  }
}

/**
 * Upload one resource and cache its `file_info`.
 *
 * The core calls this only on a cache miss, bounds the concurrency and cancels sibling uploads through the one signal
 * of `ctx`, so this function only has to honour `ctx.signal` and report the TTL it was given.
 *
 * @param bot - the adapter (its REST client).
 * @param ref - resource to upload (kind, source and the name/MIME hints of the element).
 * @param scope - chat scope (`group:<id>` / `user:<id>`); QQ keys are not interchangeable between chats.
 * @param ctx - prepare context: `fetch` for byte sources, `cache` (owned by the core), cancellation.
 * @returns the resolved `file_info` as `key`, its expiry from the platform `ttl`, and the {@link QqUploadExtra}
 * classification for the send stage.
 */
export async function uploadResource(
  bot: QQBot,
  ref: ResourceRef,
  scope: string,
  ctx: PrepareContext,
): Promise<ResolvedResource> {
  const address = addressOf(scope)
  const remote = isRemoteSource(ref.src)
 // A byte source may carry the only MIME evidence there is (a `data:` URL decoded without a type, say).
  const fetched = remote ? undefined : await ctx.fetch(ref.src, ctx.signal)
  const { fileType, downgraded } = uploadFileType(ref, fetched?.mime)
  const body: QqFileRequest = { file_type: fileType, srv_send_msg: false }
  if (fetched) body.file_data = Buffer.from(fetched.data).toString('base64')
  else body.url = ref.src
  const answer = await bot.api.uploadFile(address, body, ctx.signal)
  const extra: QqUploadExtra = { fileType, kind: ref.kind, downgraded }
  const resolved: ResolvedResource = { key: answer.file_info, extra }
 // `ttl` is in seconds and is the only expiry the platform gives; without it the key lives as long as the chat.
  if (typeof answer.ttl === 'number' && answer.ttl > 0) resolved.expiresAt = Date.now() + answer.ttl * 1000
  return resolved
}
