// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningWhaleTail } from '../src/client/chat/RunningWhaleTail.tsx'

afterEach(cleanup)

describe('RunningWhaleTail', () => {
  it('renders matching animated and resting contours for the stylesheet to switch', () => {
    const view = render(<RunningWhaleTail />)
    expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16')
    const contours = view.container.querySelectorAll('path')
    expect(contours).toHaveLength(2)
    expect(contours[1]?.getAttribute('d')).toBe(contours[0]?.getAttribute('d'))
    const animation = view.container.querySelector('animate')
    expect(animation?.getAttribute('attributeName')).toBe('d')
    expect(animation?.getAttribute('begin')).toBe('0.3s')
    expect(animation?.getAttribute('dur')).toBe('3s')
    expect(animation?.getAttribute('repeatCount')).toBe('indefinite')
    const paths = animation!.getAttribute('values')!.split(';')
    const times = animation!.getAttribute('keyTimes')!.split(';').map(Number)
    expect(paths.length).toBeGreaterThan(1)
    expect(paths).toHaveLength(times.length)
    expect(paths[0]).toBe(view.container.querySelector('path')?.getAttribute('d'))
    expect(paths.at(-1)).toBe(paths[0])
    expect(times[0]).toBe(0)
    expect(times.at(-1)).toBe(1)
    expect(times.slice(1).every((time, i) => time > times[i]!)).toBe(true)
  })
})
