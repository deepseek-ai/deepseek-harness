/** Mapping vectors cover document view coordinates. */
import { describe, expect, it } from 'vitest'
import { contentFrame, validateView, validateWindow } from '../src/client/content.ts'
import vectors from './fixtures/content-vectors.json'

const view = { x: 0, y: 0, scale: 1 }
const window = { x: 0, y: 0, width: 100, height: 80 }

describe('content mapping', () => {
  it.each(vectors.mapping)('$name', ({ window, view, expected }) => {
    validateView(view)
    validateWindow(window)
    expect(contentFrame(window, view)).toEqual(expected)
  })
  it.each([NaN, Infinity, -Infinity, 2 ** 24 + 1, -(2 ** 24 + 1)])('rejects coordinate %s', (value) => {
    for (const key of ['x', 'y'] as const) {
      expect(() => { validateView({ ...view, [key]: value }) }).toThrow(TypeError)
      expect(() => { validateWindow({ ...window, [key]: value }) }).toThrow(TypeError)
    }
  })
  it.each([NaN, Infinity, -Infinity, 0, -1, 64.001])('rejects scale %s', (scale) => {
    expect(() => { validateView({ ...view, scale }) }).toThrow(TypeError)
  })
  it.each([NaN, Infinity, -Infinity, 0, -1, 2 ** 24 + 1])('rejects extent %s', (value) => {
    for (const key of ['width', 'height'] as const) expect(() => { validateWindow({ ...window, [key]: value }) }).toThrow(TypeError)
  })
  it('accepts positive fractional extents and scale at the lower bound', () => {
    expect(() => { validateView({ ...view, scale: Number.MIN_VALUE }) }).not.toThrow()
    expect(() => { validateWindow({ ...window, width: Number.MIN_VALUE, height: Number.MIN_VALUE }) }).not.toThrow()
  })
})
