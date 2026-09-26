import { describe, expect, it } from 'vitest'
import { offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { deepSeekImageRequestPricing } from '../src/request-pricing.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import type { Options as Config } from '../src/index.ts'

const VISION_MODEL = {
  id: 'vision',
  inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
}

function ref(name: string, width: number, height: number, bytes = 1024): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${name.padEnd(8, '0')}`),
    mediaType: 'image/png',
    bytes,
    width,
    height,
    name,
  }
}

function block(attachment: ImageAttachmentRef, offloaded?: true): ImageBlock {
  return { type: 'image', attachment, ...offloaded === undefined ? {} : { offloaded } }
}

function connection(config: Omit<Config, 'models'> = {}): ReturnType<typeof resolveAdapterOptions> {
  return resolveAdapterOptions(Object.assign({ models: [VISION_MODEL] }, config))
}

describe('DeepSeek request-image pricing', () => {
  it('prices an uncatalogued model as its text-only substitution', () => {
    const image = ref('photo', 1920, 1080)
    const prices = deepSeekImageRequestPricing(connection(), 'unlisted').priceImages([block(image)])
    expect(prices).toEqual([{ visualTokens: 0, text: textOnlyImageText(image) }])
  })

  it('prices a catalogued text-only model as its text-only substitution', () => {
    const image = ref('photo', 1920, 1080)
    const options = resolveAdapterOptions({ models: [{ id: 'text-only' }] })
    const prices = deepSeekImageRequestPricing(options, 'text-only').priceImages([block(image)])
    expect(prices).toEqual([{ visualTokens: 0, text: textOnlyImageText(image) }])
  })

  it('prices a retained image by its projected request dimensions plus its handle text', () => {
    const image = ref('photo', 1920, 1080)
    const prices = deepSeekImageRequestPricing(connection(), 'vision').priceImages([block(image)])
    expect(prices).toEqual([{
      visualTokens: 968,
      text: requestImageHandleText(image, { width: 1708, height: 961 }),
    }])
  })

  it.each([
    [8192, 1, 4096, 1, 832],
    [1, 8192, 1, 4096, 1024],
  ])('prices a %sx%s image at its per-side-capped %sx%s request dimensions', (width, height, cappedWidth, cappedHeight, tokens) => {
    const image = ref('thin', width, height)
    const prices = deepSeekImageRequestPricing(connection(), 'vision').priceImages([block(image)])
    expect(prices).toEqual([{
      visualTokens: tokens,
      text: requestImageHandleText(image, { width: cappedWidth, height: cappedHeight }),
    }])
  })

  it('prices the sent dimensions when aspect-preserving projection changes the token grid', () => {
    const image = ref('portrait', 1224, 1429)
    const prices = deepSeekImageRequestPricing(connection(), 'vision').priceImages([block(image)])
    expect(prices).toEqual([{
      visualTokens: 992,
      text: requestImageHandleText(image, { width: 1187, height: 1386 }),
    }])
  })

  it('honors a numeric pixel budget override', () => {
    const image = ref('photo', 4096, 4096)
    const options = resolveAdapterOptions({
      models: [{ ...VISION_MODEL, imagePixelBudget: 640_000 }],
    })
    const prices = deepSeekImageRequestPricing(options, 'vision').priceImages([block(image)])
    expect(prices).toEqual([{
      visualTokens: 422,
      text: requestImageHandleText(image, { width: 800, height: 800 }),
    }])
  })

  it('honors the low-detail pixel budget preset', () => {
    const image = ref('photo', 4096, 4096)
    const options = resolveAdapterOptions({
      models: [{ ...VISION_MODEL, imagePixelBudget: 'low' as const }],
    })
    const prices = deepSeekImageRequestPricing(options, 'vision').priceImages([block(image)])
    expect(prices[0]!.visualTokens).toBe(184)
  })

  it('builds handle and placeholder text through the supplied access resolution', () => {
    const access = { readonlyPath: '/world/attachments/photo.png' }
    const images = [ref('first', 800, 800), ref('second', 800, 800)]
    const prices = deepSeekImageRequestPricing(
      connection(),
      'vision',
      () => access,
    ).priceImages([block(images[0]!, true), block(images[1]!)])
    expect(prices[0]).toEqual({ visualTokens: 0, text: offloadedImageText(images[0]!, access) })
    expect(prices[1]).toEqual({
      visualTokens: 422,
      text: requestImageHandleText(images[1]!, { width: 800, height: 800 }, access),
    })
    expect(prices[1]?.text).toContain('/world/attachments/photo.png')
  })

  it('prices surface-offloaded occurrences as placeholder text and every retained one at its visual price', () => {
    const images = [ref('first', 800, 800), ref('second', 800, 800), ref('third', 800, 800)]
    const prices = deepSeekImageRequestPricing(
      connection({ maxImagesPerRequest: 1, imageOffloadCountQuantum: 1 }),
      'vision',
    ).priceImages([block(images[0]!, true), block(images[1]!), block(images[2]!)])
    expect(prices).toEqual([
      { visualTokens: 0, text: offloadedImageText(images[0]!) },
      { visualTokens: 422, text: requestImageHandleText(images[1]!, { width: 800, height: 800 }) },
      { visualTokens: 422, text: requestImageHandleText(images[2]!, { width: 800, height: 800 }) },
    ])
  })

  it('prices a retained oversized occurrence at its visual price: the surface, not the budget, decides offload', () => {
    const oversized = ref('first', 800, 800, 5 * 1024 * 1024)
    const prices = deepSeekImageRequestPricing(
      connection({ maxRequestFilesBytes: 4 * 1024 * 1024, imageOffloadByteQuantum: 1 }),
      'vision',
    ).priceImages([block(oversized)])
    expect(prices.map(price => price.visualTokens)).toEqual([422])
  })
})
