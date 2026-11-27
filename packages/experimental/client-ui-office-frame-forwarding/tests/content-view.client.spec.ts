// @vitest-environment jsdom
/** Display and pointer input share the measured document origin, including centered and negative coordinates. */
import { expect, test, vi } from 'vitest'
import { contentPoint, measureContentView } from '../src/client/content-view.ts'

test.each([0.25, 0.77, 1, 4])('centered content and pointer coordinates agree at zoom %s', (zoom) => {
  const mount = document.createElement('div'), content = document.createElement('div')
  vi.spyOn(mount, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 800, 500))
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(160, -150, 680, 2000))
  const view = measureContentView(mount, content, zoom)
  expect(view).toEqual({ x: -60 * 15 / zoom, y: 200 * 15 / zoom, scale: zoom / 15 })
  expect(contentPoint(view, mount.getBoundingClientRect(), 160, 50)).toEqual({ x: 0, y: 200 * 15 / zoom })
  expect(contentPoint(view, mount.getBoundingClientRect(), 100, 50).x).toBeLessThan(0)
})
