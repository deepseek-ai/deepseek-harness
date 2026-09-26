// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('StateDot', () => {
  it.each(['done', 'warning', 'ongoing', 'error', 'idle'] as const)('renders state %s as data-state', (state) => {
    const { container } = render(<StateDot state={state} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.dataset['state']).toBe(state)
    expect(dot.getAttribute('aria-hidden')).toBe('true')
  })

  it('solid states are spans; ongoing is an svg loading spinner', () => {
    const { container, rerender } = render(<StateDot state="done" />)
    expect(container.firstElementChild?.tagName).toBe('SPAN')
    rerender(<StateDot state="ongoing" />)
    const spinner = container.firstElementChild as SVGSVGElement
    expect(spinner.tagName).toBe('svg')
    expect(spinner.querySelectorAll('rect')).toHaveLength(0)
    expect(spinner.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(spinner.querySelector('g')).not.toBeNull()
    const rings = spinner.querySelectorAll('circle')
    expect(rings).toHaveLength(2)
    expect([...rings].map(ring => ring.getAttribute('r'))).toEqual(['9.5', '9.5'])
  })

  it('sizes via the size prop in both shapes', () => {
    const { container, rerender } = render(<StateDot state="done" size={12} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.style.width).toBe('12px')
    expect(dot.style.height).toBe('12px')
    rerender(<StateDot state="ongoing" size={12} />)
    const ring = container.firstElementChild as SVGSVGElement
    expect(ring.getAttribute('width')).toBe('12')
    expect(ring.getAttribute('height')).toBe('12')
  })

  it('defaults solid dots to 10px and the ongoing loader to 14px', () => {
    const { container, rerender } = render(<StateDot state="done" />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.style.width).toBe('10px')
    expect(dot.style.height).toBe('10px')
    rerender(<StateDot state="ongoing" />)
    const spinner = container.firstElementChild as SVGSVGElement
    expect(spinner.getAttribute('width')).toBe('14')
    expect(spinner.getAttribute('height')).toBe('14')
  })

  it('rejects unknown states at the type level', () => {
    const bad = (state: StateDotState) => state
    // @ts-expect-error 'paused' is not one of the five states
    expect(bad('paused')).toBe('paused')
  })
})

it('renders completed steps with a check and pending steps without one', () => {
  const { container, rerender } = render(<StateDot state="done" appearance="step" size={16} />)
  expect(container.querySelector('[data-state="done"] svg')).toBeTruthy()
  rerender(<StateDot state="idle" appearance="step" size={16} />)
  expect(container.querySelector('[data-state="idle"] svg')).toBeNull()
  expect(container.firstElementChild?.className).toContain('step')
})

describe('StateDot ongoing phase', () => {
  it('pins every loader animation to document time zero on mount', () => {
    const animations = [{ startTime: 42 }, { startTime: 7 }]
    const getAnimations = vi.fn(() => animations)
    const proto = SVGElement.prototype as { getAnimations?: () => { startTime: number }[] }
    proto.getAnimations = getAnimations
    try {
      const { unmount } = render(<StateDot state="ongoing" />)
      expect(getAnimations).toHaveBeenCalledWith({ subtree: true })
      expect(animations.map(animation => animation.startTime)).toEqual([0, 0])
      unmount()
      expect(getAnimations).toHaveBeenCalledTimes(1)
    } finally {
      delete proto.getAnimations
    }
  })
})
