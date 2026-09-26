/**
 * Provider-side request-image pricing for DeepSeek routes: prices every
 * retained surface occurrence at its per-model request target with
 * the published vision-token accounting, and every occurrence the surface
 * marks offloaded as its placeholder text. Consumed synchronously by the
 * token meter through `LlmAdapter.imageRequestPricing`; provider usage
 * remains the authoritative anchor for completed requests.
 *
 * @module dsh-llm-deepseek/request-pricing
 */

import { offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentAccessResolver, ImageBlock, LlmImageRequestPrice, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'
import { longEdgeDimensions, requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { deepSeekImageTokens, deepSeekRequestImageDimensions } from './image-tokens.ts'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './types.ts'

/** Default bound on accumulated file-referenced image bytes per request. */
export const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024
/** Provider request image-count limit. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600
/** Total-pixel budget matching provider low-detail image input. */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
/** Encoded-byte target for one deterministic model-request image; the smallest quality-ladder output is used when no quality fits. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024
/**
 * Provider per-side limit for a request carrying 15 or more images, applied
 * to every request image so the image count never changes a projection.
 */
export const REQUEST_IMAGE_MAX_DIMENSION = 4096

/**
 * Resolve the encoded-byte target one DeepSeek model route applies to every request image.
 * @param model - Advertised model route and its optional image overrides.
 * @returns the route's encoded-byte target.
 * @internal
 */
export function resolveRequestImageMaxBytes(model: DeepSeekCatalogModel): number {
  return model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
}

/**
 * Resolve the deterministic request target one DeepSeek model route chooses
 * for one source image: the published token grid unless the model overrides
 * it with a pixel budget, then the provider per-side limit, then the route's
 * encoded-byte target. Small images are never enlarged.
 * @param model - Advertised model route and its optional image overrides.
 * @param source - intrinsic dimensions of the normalized attachment.
 * @returns Complete request dimensions and encoded-byte target.
 * @internal
 */
export function resolveRequestImageTarget(
  model: DeepSeekCatalogModel,
  source: Pick<ImageAttachmentRef, 'width' | 'height'>,
): ImageRequestTarget {
  const budget = model.imagePixelBudget === 'low' ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET : model.imagePixelBudget
  const projected = budget === undefined
    ? deepSeekRequestImageDimensions(source.width, source.height)
    : requestImageDimensions(source.width, source.height, budget)
  const capped = Math.max(projected.width, projected.height) > REQUEST_IMAGE_MAX_DIMENSION
    ? longEdgeDimensions(source.width, source.height, REQUEST_IMAGE_MAX_DIMENSION)
    : projected
  return { ...capped, maxBytes: resolveRequestImageMaxBytes(model) }
}

/**
 * Price one occurrence a text-only route substitutes with deterministic text,
 * reproducing the `projectImagesForTextModel` substitution `LlmRuntime`
 * applies before dispatching to a route without the `image` modality.
 */
function textOnlyPrice(block: ImageBlock): LlmImageRequestPrice {
  return { visualTokens: 0, text: textOnlyImageText(block.attachment) }
}

/**
 * Build the request-image pricing for one DeepSeek route from a validated
 * connection snapshot. Uncatalogued and text-only models price every
 * occurrence as its deterministic text substitution; image-capable models
 * price an offloaded occurrence as its placeholder text and a retained one by
 * its projected request dimensions, with each occurrence's handle or
 * placeholder text built through the same access resolution the serializer
 * uses. Access paths resolve at pricing time, so a path that changes before
 * the request only shifts the text price by its own length.
 * @param connection - validated connection facts of the pricing resolution.
 * @param model - exact model id named by the request header.
 * @param resolveAccess - current execution-world access resolution shared with request serialization.
 * @returns synchronous per-occurrence pricing for the route.
 */
export function deepSeekImageRequestPricing(
  connection: DeepSeekConnectionOptions,
  model: string,
  resolveAccess?: ImageAttachmentAccessResolver,
): LlmImageRequestPricing {
  const catalogModel = connection.models.find(entry => entry.id === model)
  if (catalogModel?.inputModalities?.includes('image') !== true) {
    return { priceImages: images => images.map(textOnlyPrice) }
  }
  return {
    priceImages: images => images.map(({ attachment: ref, offloaded }) => {
      if (offloaded === true) {
        return { visualTokens: 0, text: offloadedImageText(ref, resolveAccess?.(ref)) }
      }
      const target = resolveRequestImageTarget(catalogModel, ref)
      return {
        visualTokens: deepSeekImageTokens(target.width, target.height),
        text: requestImageHandleText(ref, target, resolveAccess?.(ref)),
      }
    }),
  }
}
