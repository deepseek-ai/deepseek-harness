// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningWhaleTail } from '../src/client/chat/RunningWhaleTail.tsx'

afterEach(cleanup)

describe('RunningWhaleTail', () => {
  it('renders a decorative mask seat and static SVG without inline styles', () => {
    const view = render(<RunningWhaleTail />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.children).toHaveLength(2)
    expect(icon.firstElementChild?.tagName).toBe('SPAN')
    expect(icon.firstElementChild?.childElementCount).toBe(0)
    const svg = icon.querySelector('svg')!
    expect(icon.lastElementChild).toBe(svg)
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.querySelectorAll('path')).toHaveLength(1)
    expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M/)
    expect(svg.querySelector('path')?.getAttribute('stroke')).toBe('currentColor')
    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
  })

  it('ships a 28px alpha APNG with sixty 50ms frames and infinite playback', () => {
    const png = readFileSync(resolve(import.meta.dirname, '../src/client/chat/running-whale@2x.png'))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const chunks: { type: string; data: Buffer }[] = []
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset)
      const end = offset + 12 + length
      expect(end).toBeLessThanOrEqual(png.length)
      chunks.push({ type: png.toString('ascii', offset + 4, offset + 8), data: png.subarray(offset + 8, end - 4) })
      offset = end
    }
    expect(chunks.at(-1)?.type).toBe('IEND')
    const headers = chunks.filter(chunk => chunk.type === 'IHDR')
    expect(headers).toHaveLength(1)
    const header = headers[0]!.data
    expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]]).toEqual([28, 28, 8, 4])
    const animations = chunks.filter(chunk => chunk.type === 'acTL')
    expect(animations).toHaveLength(1)
    expect([animations[0]!.data.readUInt32BE(0), animations[0]!.data.readUInt32BE(4)]).toEqual([60, 0])
    const frames = chunks.filter(chunk => chunk.type === 'fcTL')
    expect(frames).toHaveLength(60)
    let duration = 0
    for (const { data } of frames) {
      expect(data).toHaveLength(26)
      expect(data.readUInt32BE(4)).toBeGreaterThan(0)
      expect(data.readUInt32BE(8)).toBeGreaterThan(0)
      expect(data.readUInt32BE(4) + data.readUInt32BE(12)).toBeLessThanOrEqual(28)
      expect(data.readUInt32BE(8) + data.readUInt32BE(16)).toBeLessThanOrEqual(28)
      expect([data.readUInt16BE(20), data.readUInt16BE(22)]).toEqual([1, 20])
      duration += data.readUInt16BE(20) / data.readUInt16BE(22)
    }
    expect(duration).toBeCloseTo(3)
  })
})
