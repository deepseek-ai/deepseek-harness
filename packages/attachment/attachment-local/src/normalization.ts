/** Deterministic provider-independent image normalization. */

import type { Sharp } from 'sharp'
import { AttachmentError, requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { encodeFirstWithinLimit, encodingLadder, isExhaustedEncoding } from './encoding.ts'
import { detectImage, encodedAlphaIsCompatible } from './image.ts'
import type { DetectedImage } from './image.ts'
import { requireSharp } from './sharp.ts'

/** Deployment-resolved policy for the persisted normalized attachment. */
export interface NormalizationPolicy {
  /** Total-pixel budget; larger sources are downscaled proportionally. */
  maxPixels: number
  /** Long-edge cap in pixels applied after the total-pixel budget, bounding extreme aspect ratios. */
  maxDimension: number
  /** Encoded-byte target for the quality ladder; the smallest ladder output is kept when no quality fits. */
  maxBytes: number
}

/** Normalized bytes beside the facts recorded by a durable reference. */
export interface NormalizedImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

/**
 * Whether bytes already satisfy the normalization requirements.
 * @param detected - fully decoded source facts.
 * @param bytes - encoded source length.
 * @param policy - resolved normalization limits.
 * @returns whether the source can pass through byte-identically.
 */
export function canPassThroughNormalization(
  detected: DetectedImage,
  bytes: number,
  policy: NormalizationPolicy,
): boolean {
  return detected.mediaType !== 'image/gif'
    && !detected.animated
    && !detected.carriesMetadata
    && detected.depth === 'uchar'
    && detected.space === 'srgb'
    && bytes <= policy.maxBytes
    && detected.width * detected.height <= policy.maxPixels
    && Math.max(detected.width, detected.height) <= policy.maxDimension
}

/** Assert that a normalized output is an 8-bit sRGB/sRGBA single-frame image with matching facts. */
async function verifyNormalizedImage(
  image: NormalizedImage,
  expectedAlpha: boolean | undefined,
): Promise<NormalizedImage> {
  const detected = await detectImage(image.data)
  if (detected.mediaType !== image.mediaType
    || detected.width !== image.width
    || detected.height !== image.height
    || detected.animated
    || detected.carriesMetadata
    || detected.depth !== 'uchar'
    || detected.space !== 'srgb'
    || !encodedAlphaIsCompatible(expectedAlpha, detected)) {
    throw new AttachmentError(
      'Image normalization did not produce a single-frame 8-bit sRGB image with matching metadata.',
      'ATTACHMENT_WRITE_FAILED',
    )
  }
  return image
}

/** Build one fixed-size, oriented, metadata-free sRGB pipeline from submitted bytes. */
function preparedPipeline(
  sharp: ReturnType<typeof requireSharp>,
  data: Uint8Array,
  width: number,
  height: number,
): Sharp {
  return sharp(data, { failOn: 'error', limitInputPixels: false })
    .rotate()
    .toColourspace('srgb')
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
}

/** Dimensions under the total-pixel budget, then the long-edge cap, without changing aspect ratio. */
function initialDimensions(detected: DetectedImage, policy: NormalizationPolicy): { width: number; height: number } {
  const budgeted = requestImageDimensions(detected.width, detected.height, policy.maxPixels)
  const longEdge = Math.max(budgeted.width, budgeted.height)
  if (longEdge <= policy.maxDimension) return budgeted
  const scale = policy.maxDimension / longEdge
  return {
    width: Math.max(1, Math.floor(budgeted.width * scale)),
    height: Math.max(1, Math.floor(budgeted.height * scale)),
  }
}

/**
 * Produce the persisted provider-independent normalized version of one fully decoded source.
 * The source is passed through only when it is already clean, single-frame, 8-bit sRGB/sRGBA,
 * and inside every normalization limit. Re-encoding never removes transparency. When every
 * ladder quality exceeds the byte target, the smallest ladder output is kept; provider byte
 * caps stay enforced at the route that transmits the bytes.
 * @param data - complete admitted source bytes.
 * @param detected - fully decoded source facts.
 * @param policy - resolved independent normalization limits.
 * @returns verified provider-independent normalized bytes and metadata.
 */
export async function normalizeImage(
  data: Uint8Array,
  detected: DetectedImage,
  policy: NormalizationPolicy,
): Promise<NormalizedImage> {
  if (canPassThroughNormalization(detected, data.byteLength, policy)) {
    return { data, mediaType: detected.mediaType, width: detected.width, height: detected.height }
  }
  const sharp = requireSharp()
  try {
    const { width, height } = initialDimensions(detected, policy)
    const encoded = await encodeFirstWithinLimit(
      encodingLadder(preparedPipeline(sharp, data, width, height), detected.hasAlpha),
      policy.maxBytes,
    )
    const chosen = isExhaustedEncoding(encoded) ? encoded.smallest : encoded
    return await verifyNormalizedImage(chosen, detected.mediaType === 'image/gif' ? undefined : detected.hasAlpha)
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    const source = detected.mediaType === 'image/png' && detected.depth !== 'uchar'
      ? `${detected.depth === 'ushort' ? '16-bit' : detected.depth} PNG`
      : `${detected.depth} ${detected.mediaType.slice('image/'.length).toUpperCase()}`
    throw new AttachmentError(
      `The ${source} could not be converted to the normalized 8-bit sRGB form.`,
      'ATTACHMENT_WRITE_FAILED',
      { cause: error },
    )
  }
}
