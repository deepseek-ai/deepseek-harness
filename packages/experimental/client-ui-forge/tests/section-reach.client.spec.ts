// @vitest-environment jsdom
/** File sections reach the scrollport once. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SectionReach } from '../src/client/section-reach.ts'

/** An IntersectionObserver double that records its options and the elements it watches. */
class FakeObserver {
  static readonly made: FakeObserver[] = []
  readonly watched = new Set<Element>()
  disconnected = false
  constructor(readonly report: IntersectionObserverCallback, readonly options: IntersectionObserverInit | undefined) {
    FakeObserver.made.push(this)
  }
  observe(element: Element): void { this.watched.add(element) }
  unobserve(element: Element): void { this.watched.delete(element) }
  disconnect(): void {
    this.disconnected = true
    this.watched.clear()
  }
  /** Report each element as intersecting or not. */
  fire(entries: readonly (readonly [Element, boolean])[]): void {
    // The production callback reads only the entries, so the double passes itself as the observer.
    Reflect.apply(this.report, undefined, [entries.map(([target, isIntersecting]) => ({ target, isIntersecting })), this])
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeObserver.made.length = 0
})

describe('SectionReach', () => {
  it('reaches every section at once where the browser has no IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const reach = new SectionReach()
    reach.attach(document.createElement('div'))
    const reached = vi.fn()
    const stop = reach.observe(document.createElement('section'), reached)
    expect(reached).toHaveBeenCalledOnce()
    stop()
  })

  it('reaches a section once it intersects the scrollport margin and moves waiting sections to a new scrollport', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const reach = new SectionReach()
    const near = document.createElement('section')
    const far = document.createElement('section')
    const gone = document.createElement('section')
    const reachedNear = vi.fn()
    const reachedFar = vi.fn()
    reach.observe(near, reachedNear)
    reach.observe(far, reachedFar)
    const stopGone = reach.observe(gone, vi.fn())
    expect(FakeObserver.made).toHaveLength(0)

    const root = document.createElement('div')
    reach.attach(root)
    const first = FakeObserver.made[0]!
    expect(first.options).toEqual({ root, rootMargin: '1200px 0px' })
    expect([...first.watched]).toEqual([near, far, gone])
    stopGone()
    expect([...first.watched]).toEqual([near, far])

    first.fire([[near, true], [far, false]])
    expect(reachedNear).toHaveBeenCalledOnce()
    expect(reachedFar).not.toHaveBeenCalled()
    expect([...first.watched]).toEqual([far])

    const other = document.createElement('div')
    reach.attach(other)
    expect(first.disconnected).toBe(true)
    const second = FakeObserver.made[1]!
    expect(second.options?.root).toBe(other)
    expect([...second.watched]).toEqual([far])
    second.fire([[far, true]])
    expect(reachedFar).toHaveBeenCalledOnce()

    reach.attach(null)
    expect(second.disconnected).toBe(true)
    expect(FakeObserver.made).toHaveLength(2)
  })
})
