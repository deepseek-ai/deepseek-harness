import { describe, expect, it } from 'vitest'
import { resolveImageRequestBudget } from '../src/image-policy.ts'

const profile = { requestImagePixelBudget: 2048 * 2048, maxRequestImageBytes: 20 * 1024 * 1024, requestImageBudgetCount: 20 }
const model = { inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 3000, maxBytes: 4_718_592 } } } }

describe('pi-ai hard image budget', () => {
  it('allocates 0.75 MiB per image without raising the aggregate budget', () => {
    expect(resolveImageRequestBudget(model, profile))
      .toEqual({ maxPixels: 4_194_304, maxWidth: 2000, maxHeight: 3000, maxImageBytes: 786_432 })
  })

  it.each([4, 5, 6, 7, 8, 101])('honors a smaller catalog cap including base64 padding: %s', (maxBytes) => {
    const policy = resolveImageRequestBudget({ inputLimits: { images: { resize: { maxBytes } } } }, profile)
    expect(Buffer.alloc(policy.maxImageBytes).toString('base64').length).toBeLessThanOrEqual(maxBytes)
    expect(Buffer.alloc(policy.maxImageBytes + 1).toString('base64').length).toBeGreaterThan(maxBytes)
  })

  it.each([[20_971_520, 20], [83, 20], [101, 7], [400, 1]])('keeps %s base64 bytes sufficient for %s allocations', (bytes, count) => {
    const policy = resolveImageRequestBudget({}, { ...profile, maxRequestImageBytes: bytes, requestImageBudgetCount: count })
    const encodedBytes = Buffer.alloc(policy.maxImageBytes).toString('base64').length
    expect(encodedBytes * count).toBeLessThanOrEqual(bytes)
    expect(Buffer.alloc(policy.maxImageBytes + 1).toString('base64').length * count).toBeGreaterThan(bytes)
  })

  it('lets local caps replace catalog limits while preserving the aggregate allocation', () => {
    const smallCatalog = { inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 400 } } } }
    for (const requestImageMaxDimension of [1000, 3000]) {
      for (const maxImageBytes of [100, 500, 2_000_000]) {
        expect(resolveImageRequestBudget(smallCatalog, { ...profile, requestImageMaxDimension, maxImageBytes }))
          .toEqual({
            maxPixels: 4_194_304, maxWidth: requestImageMaxDimension, maxHeight: requestImageMaxDimension,
            maxImageBytes: Math.min(maxImageBytes, 786_432),
          })
      }
    }
  })

  it('changes per-image allocation only when configured budgets change', () => {
    expect(resolveImageRequestBudget(model, { ...profile, requestImageBudgetCount: 10 }).maxImageBytes).toBe(1_572_864)
    expect(resolveImageRequestBudget(model, { ...profile, maxRequestImageBytes: 40 * 1024 * 1024 }).maxImageBytes).toBe(1_572_864)
  })

  it.each([{}, { inputLimits: {} }, { inputLimits: { images: {} } }])('uses the fallback cap and allocation without catalog metadata: %j', (source) => {
    expect(resolveImageRequestBudget(source, profile)).toEqual({ maxPixels: 4_194_304, maxImageBytes: 786_432 })
    expect(resolveImageRequestBudget(source, { ...profile, requestImageBudgetCount: 1 }).maxImageBytes).toBe(1_048_576)
  })

  it('inherits omitted dimensions independently', () => {
    expect(resolveImageRequestBudget({ inputLimits: { images: { resize: { maxHeight: 1500 } } } }, profile))
      .toEqual({ maxPixels: 4_194_304, maxHeight: 1500, maxImageBytes: 786_432 })
    expect(resolveImageRequestBudget({}, { ...profile, requestImageMaxDimension: 3000, maxImageBytes: 500_000 }))
      .toEqual({ maxPixels: 4_194_304, maxWidth: 3000, maxHeight: 3000, maxImageBytes: 500_000 })
  })

  it('refuses a catalog byte budget too small for a nonempty base64 image', () => {
    expect(() => resolveImageRequestBudget({ inputLimits: { images: { resize: { maxBytes: 3 } } } }, profile))
      .toThrow(/cannot encode a nonempty base64 image/)
  })
})
