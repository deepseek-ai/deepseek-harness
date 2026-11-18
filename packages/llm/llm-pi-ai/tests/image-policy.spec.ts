import { describe, expect, it } from 'vitest'
import { resolveImageRequestBudget } from '../src/image-policy.ts'

const profile = { requestImagePixelBudget: 2048 * 2048 }

describe('pi-ai image resize policy', () => {
  it('inherits independent dimensions and converts base64 bytes without exceeding the catalog budget', () => {
    const policy = resolveImageRequestBudget({ inputLimits: { images: { resize: {
      maxWidth: 2000, maxHeight: 3000, maxBytes: 4_718_592,
    } } } }, profile)
    expect(policy).toEqual({ maxPixels: 4_194_304, maxWidth: 2000, maxHeight: 3000, maxBytes: 3_538_944 })
  })

  it.each([4, 5, 6, 7, 8, 101])('reserves base64 padding within a %s-byte budget', (maxBytes) => {
    const policy = resolveImageRequestBudget({ inputLimits: { images: { resize: { maxBytes } } } }, profile)
    expect(Buffer.alloc(policy.maxBytes).toString('base64').length).toBeLessThanOrEqual(maxBytes)
    expect(Buffer.alloc(policy.maxBytes + 1).toString('base64').length).toBeGreaterThan(maxBytes)
  })

  it('lets explicit route values raise or lower both catalog dimensions and raw byte targets', () => {
    const model = { inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 400 } } } }
    for (const requestImageMaxDimension of [1000, 3000]) {
      for (const requestImageMaxBytes of [100, 500]) {
        expect(resolveImageRequestBudget(model, { ...profile, requestImageMaxDimension, requestImageMaxBytes }))
          .toEqual({
            maxPixels: 4_194_304, maxWidth: requestImageMaxDimension, maxHeight: requestImageMaxDimension, maxBytes: requestImageMaxBytes,
          })
      }
    }
  })

  it.each([{}, { inputLimits: {} }, { inputLimits: { images: {} } }])('keeps existing defaults without catalog resize metadata: %j', (model) => {
    expect(resolveImageRequestBudget(model, profile)).toEqual({ maxPixels: 4_194_304, maxBytes: 1_048_576 })
  })

  it('inherits each omitted field independently', () => {
    expect(resolveImageRequestBudget({ inputLimits: { images: { resize: { maxHeight: 1500 } } } }, profile))
      .toEqual({ maxPixels: 4_194_304, maxHeight: 1500, maxBytes: 1_048_576 })
    expect(resolveImageRequestBudget({}, { ...profile, requestImageMaxDimension: 3000, requestImageMaxBytes: 500_000 }))
      .toEqual({ maxPixels: 4_194_304, maxWidth: 3000, maxHeight: 3000, maxBytes: 500_000 })
  })
})
