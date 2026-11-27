/** Page metadata and clipping reject malformed engine rectangles. */
import { expect, test } from 'vitest'
import { pageClipPath, pageRectangles } from '../src/client/pages.ts'

test.each(['', '0,0,1', '0,0,1,1,2', 'NaN,0,1,1', '0,0,0,1', '0,0,1,-1'])('rejects malformed page geometry %s', (rectangle) => {
  expect(() => pageRectangles(rectangle)).toThrow('Invalid Office page rectangle')
})

test('clips the static preview layer to all Writer page rectangles', () => {
  expect(pageClipPath('0,0,150,300;0,330,150,300', 1)).toBe("path('M0 0h10v20h-10Z M0 22h10v20h-10Z')")
})
