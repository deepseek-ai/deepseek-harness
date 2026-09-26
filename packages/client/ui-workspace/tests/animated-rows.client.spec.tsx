// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AnimatedRows } from '../src/client/rows/AnimatedRows.tsx'

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
      const animation = { onfinish: null, cancel } as unknown as Animation
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

  it('does not animate rows that stay outside the list viewport', () => {
    const view = render(rows(['a', 'b', 'c', 'd', 'e']))
    arm()
    view.rerender(rows(['a', 'b', 'c', 'e', 'd']))
    expect(animations).toEqual([])
  })
})
