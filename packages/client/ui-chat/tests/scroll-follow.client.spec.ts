// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScrollFollow, scrollMetrics } from '../src/client/chat/use-scroll-follow.ts'

afterEach(() => { vi.unstubAllGlobals() })

function scrollport() {
  const element = document.createElement('div')
  let height = 600
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.behavior === 'instant') element.scrollTop = options.top ?? element.scrollTop
  })
  Object.defineProperties(element, {
    clientHeight: { value: 200 },
    scrollHeight: { get: () => height },
    scrollTo: { value: scrollTo },
  })
  return { element, scrollTo, metrics: () => scrollMetrics(element), grow: (value: number) => { height = value } }
}

describe('ScrollFollow', () => {
  it('does not await native events for a fractional floor that cannot move', () => {
    const world = scrollport()
    let top = 399.6
    Object.defineProperty(world.element, 'scrollTop', {
      get: () => top, set: (value: number) => { top = Math.min(value, world.metrics().floor - 0.4) },
    })
    const follow = new ScrollFollow(true, 1)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    expect(world.scrollTo).not.toHaveBeenCalled()
    expect(follow.animating).toBe(false)
    expect(follow.active).toBe(true)
    world.grow(800)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    expect(world.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: 'smooth' })
    top = 599.6
    follow.sample(world.metrics())
    follow.toBottom(world.element, world.metrics(), 'smooth')
    expect(follow.animating).toBe(true)
    expect(world.scrollTo).toHaveBeenCalledTimes(1)
    follow.settle(world.metrics())
    follow.toBottom(world.element, world.metrics(), 'smooth')
    expect(follow.animating).toBe(false)
    expect(world.scrollTo).toHaveBeenCalledTimes(1)
  })

  it('releases only its own scrollport binding', () => {
    const { element } = scrollport()
    const first = new ScrollFollow(false, 1)
    const second = new ScrollFollow(false, 1)
    expect(ScrollFollow.forElement(element)).toBeUndefined()
    const releaseFirst = first.bind(element)
    const releaseSecond = second.bind(element)
    releaseFirst()
    expect(ScrollFollow.forElement(element)).toBe(second)
    releaseSecond()
    expect(ScrollFollow.forElement(element)).toBeUndefined()
  })

  it('keeps independent thresholds and adopts only attributed reader movement', () => {
    const outer = new ScrollFollow(true, 25)
    const inner = new ScrollFollow(true, 1)
    const metrics = { top: 380, floor: 400, height: 200 }
    expect(outer.sample(metrics, true)).toBe(true)
    expect(inner.sample(metrics, true)).toBe(false)
    expect(inner.sample({ ...metrics, top: 400 }, false)).toBe(false)
    expect(inner.sample({ ...metrics, top: 400 }, true)).toBe(true)
    inner.reset()
    expect(inner.active).toBe(false)
    expect(inner.sample({ ...metrics, top: 400 })).toBe(true)
    expect(outer.active).toBe(true)
  })

  it('finishes native motion before following the latest grown floor', () => {
    const world = scrollport()
    const follow = new ScrollFollow(false, 1)
    expect(follow.toBottom(world.element, world.metrics(), 'smooth').top).toBe(0)
    expect(world.scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: 'smooth' })
    world.element.scrollTop = 100
    expect(follow.sample(world.metrics())).toBe(true)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    expect(world.scrollTo).toHaveBeenCalledTimes(1)
    world.grow(800)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    world.grow(1_000)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    expect(world.scrollTo).toHaveBeenCalledTimes(1)
    world.element.scrollTop = 400
    expect(follow.sample(world.metrics())).toBe(true)
    expect(follow.animating).toBe(true)
    expect(follow.settle(world.metrics())).toBe(true)
    expect(follow.animating).toBe(false)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    expect(world.scrollTo).toHaveBeenCalledTimes(2)
    expect(world.scrollTo).toHaveBeenLastCalledWith({ top: 800, behavior: 'smooth' })
    world.element.scrollTop = 800
    expect(follow.sample(world.metrics())).toBe(true)
    expect(follow.settle(world.metrics())).toBe(true)
    expect(follow.animating).toBe(false)
    world.element.scrollTop = 300
    expect(follow.sample(world.metrics())).toBe(false)
  })

  it('finishes native motion when shrinking content clamps its target', () => {
    const world = scrollport()
    const follow = new ScrollFollow(true, 1)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    world.grow(300)
    world.element.scrollTop = 100
    expect(follow.sample(world.metrics())).toBe(true)
    expect(follow.settle(world.metrics())).toBe(true)
    expect(follow.animating).toBe(false)
  })

  it.each([150, 600])('releases following after a native stop at %i instead of its target', (top) => {
    const world = scrollport()
    const follow = new ScrollFollow(true, 1)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    world.grow(1_000)
    world.element.scrollTop = top
    expect(follow.sample(world.metrics())).toBe(true)
    expect(follow.settle(world.metrics())).toBe(false)
    expect(follow.animating).toBe(false)
    world.grow(1_200)
    expect(follow.sample(world.metrics())).toBe(false)
  })

  it('cancels native motion before input without treating the cancellation itself as scrolling away', () => {
    const world = scrollport()
    const follow = new ScrollFollow(true, 1)
    follow.interrupt(world.element, world.metrics())
    expect(world.scrollTo).not.toHaveBeenCalled()
    follow.toBottom(world.element, world.metrics(), 'smooth')
    world.element.scrollTop = 150
    follow.sample(world.metrics())
    follow.interrupt(world.element, world.metrics())
    expect(world.scrollTo).toHaveBeenLastCalledWith({ top: 150, behavior: 'instant' })
    expect(follow.animating).toBe(false)
    expect(follow.sample(world.metrics())).toBe(true)
    expect(follow.settle(world.metrics())).toBe(true)
    world.element.scrollTop = 100
    expect(follow.sample(world.metrics())).toBe(false)
    world.element.scrollTop = 400
    expect(follow.sample(world.metrics())).toBe(true)
  })

  it('positions opening and external landings immediately within the current range', () => {
    const world = scrollport()
    const follow = new ScrollFollow(false, 1)
    expect(follow.toBottom(world.element, world.metrics(), 'instant').top).toBe(400)
    expect(follow.toBottom(world.element, world.metrics(), 'smooth').top).toBe(400)
    expect(world.scrollTo).not.toHaveBeenCalled()
    expect(follow.jump(world.element, world.metrics(), -100).top).toBe(0)
    expect(follow.active).toBe(false)
    expect(follow.jump(world.element, world.metrics(), 1_000).top).toBe(400)
    expect(follow.active).toBe(true)
  })

  it('uses immediate following under reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const world = scrollport()
    const follow = new ScrollFollow(false, 1)
    expect(follow.toBottom(world.element, world.metrics(), 'smooth').top).toBe(400)
    expect(follow.animating).toBe(false)
    expect(world.scrollTo).not.toHaveBeenCalled()
  })

  it('stops a native animation when an explicit jump retains the current offset', () => {
    const world = scrollport()
    const follow = new ScrollFollow(false, 1)
    follow.toBottom(world.element, world.metrics(), 'smooth')
    follow.jump(world.element, world.metrics(), 0)
    expect(world.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' })
    expect(follow.animating).toBe(false)
    expect(follow.active).toBe(false)
  })
})
