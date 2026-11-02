// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AnimatedRows } from '../src/AnimatedRows.tsx'

interface RecordedAnimation {
  element: HTMLElement
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  animation: Animation
  cancel: Mock<() => void>
}

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
let animations: RecordedAnimation[]
let reducedMotion: boolean
let measure: MockInstance<() => DOMRect>

beforeEach(() => {
  animations = []
  reducedMotion = false
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation {
      const cancel = vi.fn<() => void>()
      const methods: Pick<Animation, 'onfinish' | 'cancel'> = { onfinish: null, cancel }
      const animation = methods as Animation
      animations.push({ element: this, keyframes, options, animation, cancel })
      return animation
    },
  })
  measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.rowKey === undefined) return new DOMRect(0, 0, 200, 102)
    const tree = this.closest('[role="tree"]') as HTMLElement
    const index = Array.from(tree.querySelectorAll('[data-row-key]')).indexOf(this)
    return new DOMRect(0, index * 34, 200, 32)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalAnimate === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  else Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
})

function rows(keys: readonly string[], options: { ready?: boolean; resetKey?: string; suffix?: string } = {}) {
  return <div style={{ position: 'relative' }}>
    <AnimatedRows
      className="rows"
      role="tree"
      label="Sessions"
      rowKeys={keys}
      ready={options.ready ?? true}
      resetKey={options.resetKey ?? 'manual'}
    >
      {keys.map(key => <div key={key} data-row-key={key} role="treeitem" style={{ opacity: 1 }}>
        {key}{options.suffix}
      </div>)}
    </AnimatedRows>
  </div>
}

function arm(): HTMLElement {
  const tree = screen.getByRole('tree')
  fireEvent.pointerDown(tree)
  return tree
}

function finish(animation: Animation): void {
  animation.onfinish?.call(animation, new Event('finish') as AnimationPlaybackEvent)
}

function naturalHeightRows(tree: HTMLElement, top = 0): void {
  measure.mockImplementation(function (this: HTMLElement) {
    const items = Array.from(tree.querySelectorAll('[data-row-key]'))
    if (this === tree) return new DOMRect(0, top, 200, items.length * 34)
    if (this.dataset.rowKey !== undefined) return new DOMRect(0, top + items.indexOf(this) * 34, 200, 32)
    return new DOMRect(0, top, 200, items.length * 34)
  })
}

describe('AnimatedRows', () => {
  it('settles initial arrivals and glides a subsequent pin reorder', () => {
    const view = render(rows(['a']))
    view.rerender(rows(['a', 'b']))
    expect(measure).not.toHaveBeenCalled()
    expect(animations).toEqual([])

    arm()
    view.rerender(rows(['b', 'a']))
    expect(animations.map(call => [call.element.textContent, call.options.duration])).toEqual([['b', 200], ['a', 200]])
    expect(animations[0]?.keyframes).toEqual([
      { transform: 'translate(0px, 34px)', opacity: 1 },
      { transform: 'translate(0, 0)', opacity: 1 },
    ])
    for (const call of animations) finish(call.animation)
  })

  it('fades changed membership while surviving rows fill the gap', () => {
    const view = render(rows(['a', 'b', 'c']))
    const tree = arm()
    view.rerender(rows(['b', 'c', 'd']))
    expect(within(tree).queryByText('a')).toBeNull()
    expect(animations.map(call => [call.element.textContent, call.options.duration]))
      .toEqual([['b', 200], ['c', 200], ['d', 100], ['a', 100]])
    const leaving = animations[3] as RecordedAnimation
    expect(leaving.element.inert).toBe(true)
    expect(leaving.element.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(leaving.element.style.position).toBe('absolute')
    expect(leaving.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }])
    finish(leaving.animation)
    expect(leaving.element.isConnected).toBe(false)
  })

  it('fades the last row when the list becomes empty', () => {
    const view = render(rows(['a']))
    arm()
    view.rerender(rows([]))
    expect(animations).toHaveLength(1)
    expect(animations[0]?.options.duration).toBe(100)
    expect(animations[0]?.element.inert).toBe(true)
    finish(animations[0]!.animation)
    expect(animations[0]?.element.isConnected).toBe(false)
  })

  it('does not measure content-only updates or scrolling, or interrupt their ongoing movement', () => {
    const view = render(rows(['a', 'b']))
    const tree = arm()
    view.rerender(rows(['b', 'a']))
    measure.mockClear()
    view.rerender(rows(['b', 'a'], { suffix: ' updated' }))
    fireEvent.scroll(tree)
    fireEvent(window, new Event('resize'))
    expect(measure).not.toHaveBeenCalled()
    expect(animations).toHaveLength(2)
    for (const call of animations) expect(call.cancel).not.toHaveBeenCalled()
  })

  it.each(['loading', 'view change', 'reduced motion', 'unsupported browser'])('settles %s without measuring', (mode) => {
    const view = render(rows(['a', 'b']))
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' })
    if (mode === 'reduced motion') reducedMotion = true
    if (mode === 'unsupported browser') Object.defineProperty(HTMLElement.prototype, 'animate', { value: undefined })
    view.rerender(rows(['b', 'a'], {
      ready: mode !== 'loading', resetKey: mode === 'view change' ? 'updated' : 'manual',
    }))
    expect(measure).not.toHaveBeenCalled()
    expect(animations).toEqual([])
  })

  it('redirects interrupted movement from the current displayed position', () => {
    const view = render(rows(['a', 'b']))
    arm()
    view.rerender(rows(['b', 'a']))
    const moving = animations[1] as RecordedAnimation
    vi.spyOn(moving.element, 'getBoundingClientRect').mockImplementation(() => new DOMRect(
      0, moving.cancel.mock.calls.length === 0 ? 12 : 0, 200, 32,
    ))
    view.rerender(rows(['a', 'b']))
    expect(moving.cancel).toHaveBeenCalledOnce()
    expect(animations[2]?.keyframes[0]).toEqual({ transform: 'translate(0px, 12px)', opacity: 1 })
  })

  it('removes an exit copy when its row returns and cancels owned animations on unmount', () => {
    const view = render(rows(['a', 'b']))
    arm()
    view.rerender(rows(['b']))
    const leaving = animations.find(call => call.element.textContent === 'a') as RecordedAnimation
    view.rerender(rows(['a', 'b']))
    expect(leaving.element.isConnected).toBe(false)
    expect(screen.getAllByText('a')).toHaveLength(1)
    view.rerender(rows(['a']))
    view.unmount()
    for (const call of animations) expect(call.cancel).toHaveBeenCalled()
  })

  it('animates only rows inside the window when 300 natural-height rows reorder', () => {
    vi.stubGlobal('innerHeight', 324)
    const keys = Array.from({ length: 300 }, (_, index) => String(index))
    const view = render(rows(keys))
    const tree = arm()
    naturalHeightRows(tree, 50 - 100 * 34)
    const reordered = keys.map((_, index) => String(index % 2 === 0 ? index + 1 : index - 1))
    view.rerender(rows(reordered))
    expect(animations.map(call => call.element.dataset.rowKey))
      .toEqual(['99', '98', '101', '100', '103', '102', '105', '104', '107', '106', '109', '108'])
    expect(animations.every(call => call.options.duration === 200)).toBe(true)
    expect(tree.querySelectorAll('[data-row-key]')).toHaveLength(300)
  })

  it('fades entries and exits only inside the window', () => {
    vi.stubGlobal('innerHeight', 68)
    const view = render(rows(['a', 'b', 'c', 'd', 'e']))
    const tree = arm()
    naturalHeightRows(tree)
    view.rerender(rows(['x', 'y', 'z', 'w', 'v']))
    expect(animations.map(call => [call.element.textContent, call.options.duration])).toEqual([
      ['x', 100], ['y', 100], ['a', 100], ['b', 100],
    ])
    expect(animations.filter(call => call.element.inert)).toHaveLength(2)
  })

  it('compares previous positions with the window bounds measured before the commit', () => {
    vi.stubGlobal('innerHeight', 102)
    const content = (keys: readonly string[], top: number) => <div data-testid="shift" style={{ top }}>{rows(keys)}</div>
    const view = render(content(['a', 'b', 'c', 'd', 'e', 'f'], 0))
    const tree = arm()
    const shift = screen.getByTestId('shift')
    measure.mockImplementation(function (this: HTMLElement) {
      const items = Array.from(tree.querySelectorAll('[data-row-key]'))
      const top = Number.parseFloat(shift.style.top)
      if (this.dataset.rowKey !== undefined) return new DOMRect(0, top + items.indexOf(this) * 34, 200, 32)
      return new DOMRect(0, top, 200, items.length * 34)
    })
    view.rerender(content(['b', 'a', 'c', 'd', 'f', 'e'], -136))
    expect(animations.map(call => call.element.dataset.rowKey)).toEqual(['b', 'a', 'c', 'f', 'e'])
  })

  it('limits natural-height lists to the window', () => {
    vi.stubGlobal('innerHeight', 68)
    const view = render(rows(['a', 'b', 'c', 'd']))
    const tree = arm()
    naturalHeightRows(tree)
    view.rerender(rows(['b', 'a', 'd', 'c']))
    expect(animations.map(call => call.element.dataset.rowKey)).toEqual(['b', 'a'])
  })

  it('does not animate rows that stay outside the list viewport', () => {
    const view = render(rows(['a', 'b', 'c', 'd', 'e']))
    arm()
    view.rerender(rows(['a', 'b', 'c', 'e', 'd']))
    expect(animations).toEqual([])
  })
})
