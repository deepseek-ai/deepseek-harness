import { describe, expect, it } from 'vitest'
import { longEdgeDimensions, requestImageDimensions } from '../src/index.ts'

describe('request image dimensions', () => {
  it.each([
    [4096, 4096, 800, 800],
    [4096, 2048, 1130, 565],
    [3840, 2160, 1066, 600],
    [320, 240, 320, 240],
  ])('projects %sx%s under 640,000 pixels as %sx%s', (width, height, expectedWidth, expectedHeight) => {
    const projected = requestImageDimensions(width, height, 640_000)
    expect(projected).toEqual({
      width: expectedWidth,
      height: expectedHeight,
    })
    expect(projected.width * projected.height).toBeLessThanOrEqual(640_000)
  })

  it('projects a portrait within the same total-pixel budget', () => {
    const projected = requestImageDimensions(2160, 3840, 640_000)

    expect(projected).toEqual({ width: 600, height: 1066 })
    expect(projected.width * projected.height).toBeLessThanOrEqual(640_000)
  })

  it.each([
    [1146, 3657, 4194304, 2000, 2000, 627, 2000],
    [3657, 1146, 4194304, 2000, 2000, 2000, 627],
    [4000, 800, 4194304, 3000, 300, 1500, 300],
    [800, 4000, 4194304, 300, 3000, 300, 1500],
    [4000, 4000, 1000000, 2000, 2000, 1000, 1000],
    [320, 240, 4194304, 2000, 2000, 320, 240],
    [1, 8192, 4194304, 2000, 2000, 1, 2000],
  ])('fits %sx%s within %s pixels and %sx%s', (width, height, pixels, maxWidth, maxHeight, expectedWidth, expectedHeight) => {
    const projected = requestImageDimensions(width, height, pixels, maxWidth, maxHeight)
    expect(projected).toEqual({ width: expectedWidth, height: expectedHeight })
    expect(projected.width * projected.height).toBeLessThanOrEqual(pixels)
    expect(projected.width).toBeLessThanOrEqual(maxWidth)
    expect(projected.height).toBeLessThanOrEqual(maxHeight)
  })

  it('rounds a portrait inward when integer aspect rounding crosses the pixel cap', () => {
    expect(requestImageDimensions(2, 4, 5)).toEqual({ width: 1, height: 2 })
  })
})

describe('long-edge dimensions', () => {
  it('keeps the long edge exact and rounds the short edge', () => {
    expect(longEdgeDimensions(8000, 40, 4096)).toEqual({ width: 4096, height: 20 })
    expect(longEdgeDimensions(10_000, 100, 4096)).toEqual({ width: 4096, height: 41 })
    expect(longEdgeDimensions(1080, 2400, 1862)).toEqual({ width: 838, height: 1862 })
    expect(longEdgeDimensions(1, 9000, 4096)).toEqual({ width: 1, height: 4096 })
  })

  it('never enlarges a source at or below the long edge', () => {
    expect(longEdgeDimensions(320, 240, 320)).toEqual({ width: 320, height: 240 })
    expect(longEdgeDimensions(320, 240, 4096)).toEqual({ width: 320, height: 240 })
  })
})
