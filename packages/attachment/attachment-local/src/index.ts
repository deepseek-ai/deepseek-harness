/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */

import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { NormalizationPolicy } from './normalization.ts'
import { CompressionLimiter, compressionFailure } from './compression-limiter.ts'
import { commitPreparedImageFile, normalizedImagePath, prepareImageFile, readImageFile, validateImageFile } from './store.ts'
import {
  readFileStreamVerbatim, saveFileStreamVerbatim, saveFileVerbatim, storedFilePath,
} from './file-store.ts'
import { readRequestImageFile, requestImageVariantId } from './request-image.ts'

export { canPassThroughNormalization, normalizeImage } from './normalization.ts'
export type { NormalizedImage, NormalizationPolicy } from './normalization.ts'
export { commitPreparedImageFile, prepareImageFile, readImageFile, saveImageFile, validateImageFile } from './store.ts'
export type { PreparedImageFile } from './store.ts'
export { readRequestImageFile, requestImageVariantId } from './request-image.ts'

/** Default maximum encoded bytes for one submitted image; oversized sources are refused, not shrunk. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024
/** Default maximum intrinsic pixels for one submitted image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 64_000_000
/** Default per-side pixel cap for one submitted image. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 8192
/**
 * Default total-pixel budget of the stored normalized image. A larger source
 * is admitted and downscaled proportionally, so admission bounds what rides
 * every later model request without refusing ordinary large sources; extreme
 * aspect ratios keep their short-edge resolution instead of collapsing under
 * a long-edge rule.
 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS = 2048 * 2048
/** Default long-edge cap of the stored normalized image, applied after the total-pixel budget. */
export const DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 8192
/** Default encoded-byte target for one stored normalized image. */
export const DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/** Conservative default number of simultaneous native image transformations per store. */
export const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2
/** Maximum configurable native image transformations per store. */
export const MAX_IMAGE_COMPRESSION_CONCURRENCY = 8

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Maximum encoded bytes accepted for one submitted image. Default: 20 MiB. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. Default: 20. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. Default: 200 MiB. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one submitted image. Default: 64,000,000. */
  maxImagePixels?: number
  /** Maximum intrinsic width and maximum intrinsic height accepted for one submitted image. Default: 8192px. */
  maxImageDimension?: number
  /** Total-pixel budget of the stored provider-independent normalized image. */
  normalizedImageMaxPixels?: number
  /** Long-edge pixel cap of the stored provider-independent normalized image, applied after the total-pixel budget. */
  normalizedImageMaxDimension?: number
  /**
   * Encoded-byte target of the stored provider-independent normalized image;
   * the smallest quality-ladder output is kept when no quality fits.
   */
  normalizedImageMaxBytes?: number
  /** Maximum simultaneous normalization or request-image transformations in this service instance. */
  imageCompressionConcurrency?: number
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('Attachment request cancelled with a non-Error reason.', { cause: reason })
}

class SharedRequest<T> {
  readonly controller = new AbortController()
  readonly promise: Promise<T>
  private settled = false
  private waiters = 0

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  wait(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    this.waiters += 1
    if (signal === undefined) {
      return this.promise.finally(() => {
        this.release(false)
      })
    }
    let released = false
    const release = (cancelled: boolean): void => {
      if (released) return
      released = true
      this.release(cancelled, signal)
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        release(true)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', abort, { once: true })
      void this.promise.then((value) => {
        signal.removeEventListener('abort', abort)
        release(false)
        resolve(value)
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        release(false)
        reject(compressionFailure(error))
      })
    })
  }

  private release(cancelled: boolean, signal?: AbortSignal): void {
    this.waiters -= 1
    if (cancelled && this.waiters === 0 && !this.settled && signal !== undefined) {
      this.controller.abort(abortReason(signal))
    }
  }
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
    normalizedImageMaxPixels: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS),
    normalizedImageMaxDimension: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION),
    normalizedImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_BYTES),
    imageCompressionConcurrency: z.number().step(1).min(1).max(MAX_IMAGE_COMPRESSION_CONCURRENCY)
      .default(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits
  /** Resolved provider-independent normalization policy. */
  readonly normalizationPolicy: Readonly<NormalizationPolicy>
  /** Resolved instance-level compression limit. */
  readonly imageCompressionConcurrency: number
  private readonly compression: CompressionLimiter
  private readonly requestInflight = new Map<string, SharedRequest<RequestImageAttachment>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(join(resolveDshHome(config.dshHome), 'attachments', 'v1'))
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.normalizationPolicy = Object.freeze({
      maxPixels: config.normalizedImageMaxPixels ?? DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
      maxDimension: config.normalizedImageMaxDimension ?? DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
      maxBytes: config.normalizedImageMaxBytes ?? DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    })
    const compressionConcurrency = config.imageCompressionConcurrency ?? DEFAULT_IMAGE_COMPRESSION_CONCURRENCY
    if (!Number.isSafeInteger(compressionConcurrency)
      || compressionConcurrency < 1
      || compressionConcurrency > MAX_IMAGE_COMPRESSION_CONCURRENCY) {
      throw new Error(
        `attachment-local: imageCompressionConcurrency must be an integer from 1 through ${MAX_IMAGE_COMPRESSION_CONCURRENCY}`,
      )
    }
    this.imageCompressionConcurrency = compressionConcurrency
    this.compression = new CompressionLimiter(compressionConcurrency)
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.compression.run(() => validateImageFile(input, this.imageLimits, this.normalizationPolicy))
  }

  override async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.validateImageBatch(inputs)
    const prepared = await Promise.all(inputs.map(input => this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.normalizationPolicy),
    )))
    const refs: ImageAttachmentRef[] = []
    for (const image of prepared) refs.push(await commitPreparedImageFile(this.root, image))
    return refs
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const prepared = await this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.normalizationPolicy),
    )
    return commitPreparedImageFile(this.root, prepared)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  override imageHostPath(ref: ImageAttachmentRef): string {
    return normalizedImagePath(this.root, ref)
  }

  override async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return saveFileVerbatim(this.root, input)
  }

  override async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    return saveFileStreamVerbatim(this.root, input)
  }

  override readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    return readFileStreamVerbatim(this.root, ref, signal)
  }

  override fileHostPath(ref: FileAttachmentRef): string {
    return storedFilePath(this.root, ref)
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return this.requestVersion(ref, policy, undefined, signal)
  }

  private requestVersion(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    stored: StoredImageAttachment | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const variantId = requestImageVariantId(ref, policy)
    const key = String(variantId)
    let operation = this.requestInflight.get(key)
    if (operation?.controller.signal.aborted) {
      this.requestInflight.delete(key)
      operation = undefined
    }
    if (operation === undefined) {
      const shared = new SharedRequest<RequestImageAttachment>(sharedSignal => this.compression.run(async () => {
        const request = await readRequestImageFile(
          this.root,
          stored ?? await this.readImage(ref, sharedSignal),
          policy,
          sharedSignal,
        )
        return request
      }))
      operation = shared
      this.requestInflight.set(key, shared)
      void shared.promise.finally(() => {
        if (this.requestInflight.get(key) === shared) this.requestInflight.delete(key)
      }).catch(() => {})
    }
    return operation.wait(signal)
  }

}

export default LocalAttachmentStore
