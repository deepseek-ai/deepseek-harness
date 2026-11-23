/** Resolve pi-ai image resize metadata and route-owned overrides. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Api, Model } from '@earendil-works/pi-ai'
import { DEFAULT_REQUEST_IMAGE_MAX_BYTES } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import type { PiImageRequestBudget } from './context.ts'

/**
 * Resolve one model's image dimensions and hard raw encoded-byte limit.
 * @param model - selected pi-ai catalog model.
 * @param profile - validated route with optional overrides.
 * @returns resize limits shared by request serialization and screenshot coordinates.
 */
export function resolveImageRequestBudget(
  model: Pick<Model<Api>, 'inputLimits'>,
  profile: Pick<ResolvedPiAiProviderProfile,
    'requestImagePixelBudget' | 'requestImageMaxDimension' | 'maxImageBytes' | 'maxRequestImageBytes' | 'requestImageBudgetCount'>,
): PiImageRequestBudget {
  const resize = model.inputLimits?.images?.resize
  const maxWidth = profile.requestImageMaxDimension ?? resize?.maxWidth
  const maxHeight = profile.requestImageMaxDimension ?? resize?.maxHeight
  // Each four base64 characters carry at most three raw bytes, including padding.
  const catalogBytes = resize?.maxBytes === undefined ? undefined : Math.floor(resize.maxBytes / 4) * 3
  const allocatedBytes = Math.floor(profile.maxRequestImageBytes / profile.requestImageBudgetCount / 4) * 3
  const maxImageBytes = Math.min(allocatedBytes, profile.maxImageBytes ?? catalogBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES)
  if (maxImageBytes < 1) {
    throw new LlmError('pi-ai image byte budget cannot encode a nonempty base64 image; increase the image byte limits.', 'INVALID_CONFIG')
  }
  return {
    maxPixels: profile.requestImagePixelBudget,
    maxImageBytes,
    ...maxWidth === undefined ? {} : { maxWidth },
    ...maxHeight === undefined ? {} : { maxHeight },
  }
}
