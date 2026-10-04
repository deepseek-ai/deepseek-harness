// @vitest-environment jsdom
/** Menu-group naming, sticky transitions, and viewport-observer ownership. */
import { cleanup, fireEvent, isInaccessible, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MenuGroup, observeStickyMenuGroups } from '../src/MenuGroup.tsx'

const disposers: (() => void)[] = []
const intersections: StubIntersectionObserver[] = []
const sizes: StubResizeObserver[] = []

class StubIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly scrollMargin = '0px'
  readonly thresholds: readonly number[]
  observe = vi.fn<(target: Element) => void>()
  unobserve = vi.fn<(target: Element) => void>()
  disconnect = vi.fn<() => void>()
  takeRecords = vi.fn<() => IntersectionObserverEntry[]>(() => [])
  constructor(private readonly callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? '0px'
    this.thresholds = typeof options.threshold === 'number' ? [options.threshold] : options.threshold ?? [0]
    intersections.push(this)
  }
  notify(...entries: IntersectionObserverEntry[]): void { this.callback(entries, this) }
}

class StubResizeObserver implements ResizeObserver {
  observe = vi.fn<(target: Element, options?: ResizeObserverOptions) => void>()
  unobserve = vi.fn<(target: Element) => void>()
  disconnect = vi.fn<() => void>()
  constructor(private readonly callback: ResizeObserverCallback) { sizes.push(this) }
  notify(target: Element, height = 200): void {
    const size: ResizeObserverSize = { blockSize: height, inlineSize: 200 }
    this.callback([{
      target, contentRect: new DOMRect(0, 0, 200, height),
      borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size],
    }], this)
  }
}

beforeEach(() => {
  intersections.length = 0
  sizes.length = 0
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function observe(viewport: HTMLElement): () => void {
  const dispose = observeStickyMenuGroups(viewport)
  disposers.push(dispose)
  return dispose
}

function directChild(section: HTMLElement, attribute: string): HTMLElement {
  const child = section.querySelector<HTMLElement>(`:scope > [${attribute}]`)
  if (!child) throw new Error(`Missing ${attribute}`)
  return child
}

function fixture() {
  const view = render(
    <div data-testid="viewport">
      <MenuGroup label="Provider A"><button type="button">Model A</button></MenuGroup>
      <MenuGroup label="Provider B"><button type="button">Model B</button></MenuGroup>
      <MenuGroup label="Provider C"><button type="button">Model C</button></MenuGroup>
    </div>,
  )
  const viewport = screen.getByTestId('viewport')
  const groups = screen.getAllByRole('group').map(section => ({
    section, heading: directChild(section, 'data-menu-group-heading'), start: directChild(section, 'data-menu-group-start'),
  }))
  return { ...view, viewport, groups }
}

function entry(
  target: Element, top: number, height: number, time: number, rootHeight = 1,
  rootBounds: DOMRectReadOnly | null = new DOMRect(0, 100, 200, rootHeight),
): IntersectionObserverEntry {
  const bottom = top + height
  const intersectionTop = Math.max(top, 100)
  const intersectionBottom = Math.min(bottom, 100 + rootHeight)
  const intersectionHeight = Math.max(0, intersectionBottom - intersectionTop)
  return {
    target, time, boundingClientRect: new DOMRect(0, top, 200, height),
    rootBounds,
    intersectionRect: new DOMRect(0, intersectionTop, 200, intersectionHeight),
    intersectionRatio: intersectionHeight / height, isIntersecting: bottom >= 100 && top <= 100 + rootHeight,
  }
}

function startEntry(target: Element, top: number, time: number): IntersectionObserverEntry {
  return entry(target, top, 1, time, 200)
}

function startObserving(viewport: HTMLElement) {
  const dispose = observe(viewport)
  const start = intersections[0]!
  const size = sizes[0]!
  size.notify(viewport)
  const strip = intersections[1]!
  return { dispose, start, size, strip }
}

describe('MenuGroup', () => {
  it('names each section with a unique direct heading and keeps the sentinel out of the accessible tree', () => {
    const { groups: [first, second] } = fixture()
    expect(first!.section.tagName).toBe('SECTION')
    expect(first!.section.hasAttribute('data-menu-group')).toBe(true)
    expect(first!.section.getAttribute('aria-labelledby')).toBe(first!.heading.id)
    expect(second!.section.getAttribute('aria-labelledby')).toBe(second!.heading.id)
    expect(first!.heading.id).not.toBe('')
    expect(first!.heading.id).not.toBe(second!.heading.id)
    expect(first!.start.getAttribute('aria-hidden')).toBe('true')
    expect(isInaccessible(first!.start)).toBe(true)
    expect(first!.start.textContent).toBe('')
    expect(first!.start.hasAttribute('tabindex')).toBe(false)
    expect(first!.heading.nextElementSibling).toBe(within(first!.section).getByRole('button', { name: 'Model A' }))
  })

  it('renders a named group without rows', () => {
    render(<MenuGroup label="Empty provider" />)
    const group = screen.getByRole('group', { name: 'Empty provider' })
    expect(group.children).toHaveLength(2)
    expect(group.getAttribute('aria-labelledby')).toBe(within(group).getByText('Empty provider').id)
  })
})

describe('observeStickyMenuGroups', () => {
  it('does not synchronously read layout when observing a 30-model menu', () => {
    render(<div data-testid="large-viewport">{Array.from({ length: 6 }, (_, index) =>
      <MenuGroup key={index} label={`Provider ${index}`}>
        {Array.from({ length: 5 }, (_, row) => <button key={row} type="button">{`Model ${index}-${row}`}</button>)}
      </MenuGroup>)}</div>)
    const viewport = screen.getByTestId('large-viewport')
    const groups = screen.getAllByRole('group')
    const read = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    const clientRects = vi.spyOn(Element.prototype, 'getClientRects')
    const computedStyle = vi.spyOn(window, 'getComputedStyle')
    const offsetTop = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get')
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    const clientHeight = vi.spyOn(Element.prototype, 'clientHeight', 'get')
    const addScroll = vi.spyOn(viewport, 'addEventListener')
    const addResize = vi.spyOn(window, 'addEventListener')
    const dispose = observe(viewport)
    expect(read).not.toHaveBeenCalled()
    expect(intersections).toHaveLength(1)
    expect(sizes).toHaveLength(1)
    const start = intersections[0]!
    const size = sizes[0]!
    expect(start.observe).toHaveBeenCalledTimes(6)
    expect(size.observe.mock.calls).toEqual([[viewport]])
    size.notify(viewport)
    const strip = intersections[1]!
    expect(strip.observe.mock.calls).toEqual(groups.map(group => [group]))
    strip.notify(...groups.map((group, index) => entry(group, 100 + index * 203, 200, 1)))
    start.notify(...groups.map((group, index) => startEntry(directChild(group, 'data-menu-group-start'), 100 + index * 203, 1)))
    expect(directChild(groups[0]!, 'data-menu-group-heading').hasAttribute('data-stuck')).toBe(false)
    viewport.scrollTop = 0.25
    fireEvent.scroll(viewport)
    start.notify(startEntry(directChild(groups[0]!, 'data-menu-group-start'), 99.75, 2))
    expect(directChild(groups[0]!, 'data-menu-group-heading').hasAttribute('data-stuck')).toBe(true)
    fireEvent.resize(window)
    size.notify(viewport, 180)
    intersections[2]!.notify(entry(groups[0]!, 99.75, 200, 3))
    dispose()
    for (const spy of [read, clientRects, computedStyle, offsetTop, offsetHeight, clientHeight]) {
      expect(spy).not.toHaveBeenCalled()
    }
    expect(addScroll).not.toHaveBeenCalled()
    expect(addResize).not.toHaveBeenCalled()
  })

  it('waits for asynchronous size and intersection delivery, including an already-scrolled viewport', () => {
    const { viewport, groups: [first] } = fixture()
    viewport.scrollTop = 20
    observe(viewport)
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    expect(intersections).toHaveLength(1)
    intersections[0]!.notify(startEntry(first!.start, 80, 1))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    sizes[0]!.notify(viewport)
    intersections[1]!.notify(entry(first!.section, 80, 100, 2))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(true)
  })

  it('keeps the initial top transparent, handles fractional crossing, and clears on upward return to zero', () => {
    const { viewport, groups: [first] } = fixture()
    const { start, strip } = startObserving(viewport)
    expect(start.root).toBe(viewport)
    expect(start.thresholds).toEqual([0, 1])
    expect(strip.root).toBe(viewport)
    expect(strip.rootMargin).toBe('0px 0px -199px 0px')
    expect(strip.thresholds).toEqual([0])
    const write = vi.spyOn(first!.heading, 'toggleAttribute')
    strip.notify(entry(first!.section, 100, 100, 1))
    start.notify(startEntry(first!.start, 100, 1))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    expect(write).not.toHaveBeenCalled()
    // The section still intersects the strip, so only the sentinel crosses a threshold.
    start.notify(startEntry(first!.start, 99.75, 2))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(true)
    start.notify(startEntry(first!.start, 99, 3))
    expect(write).toHaveBeenCalledTimes(1)
    start.notify(startEntry(first!.start, 100, 4))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('clears at the section tail and hands off only after the following group crosses the top', () => {
    const { viewport, groups: [first, second] } = fixture()
    const { start, strip } = startObserving(viewport)
    strip.notify(entry(first!.section, 80, 100, 1), entry(second!.section, 183, 100, 1))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(true)
    expect(second!.heading.hasAttribute('data-stuck')).toBe(false)
    strip.notify(entry(first!.section, 0, 100, 2))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    strip.notify(entry(first!.section, -3, 100, 3), entry(second!.section, 100, 100, 3))
    expect(second!.heading.hasAttribute('data-stuck')).toBe(false)
    start.notify(startEntry(second!.start, 99.75, 4))
    expect(second!.heading.hasAttribute('data-stuck')).toBe(true)
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
  })

  it('finds the middle group after a fast jump even when its sentinel reports no new intersection', () => {
    const { viewport, groups: [first, second, third] } = fixture()
    const { start, strip } = startObserving(viewport)
    start.notify(startEntry(first!.start, 100, 1), startEntry(second!.start, 503, 1), startEntry(third!.start, 906, 1))
    strip.notify(entry(first!.section, 100, 400, 1), entry(second!.section, 503, 400, 1), entry(third!.section, 906, 400, 1))
    strip.notify(entry(first!.section, -450, 400, 2), entry(second!.section, -47, 400, 2))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    expect(second!.heading.hasAttribute('data-stuck')).toBe(true)
    expect(third!.heading.hasAttribute('data-stuck')).toBe(false)
  })

  it('orders samples from both observers by entry time rather than callback delivery', () => {
    const { viewport, groups: [first] } = fixture()
    const { start, strip } = startObserving(viewport)
    start.notify(startEntry(first!.start, 99.75, 3))
    strip.notify(entry(first!.section, 100, 100, 2))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(true)
    start.notify(startEntry(first!.start, 100, 1))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(true)
    strip.notify(entry(first!.section, -1, 100, 5))
    strip.notify(entry(first!.section, 80, 100, 4))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    strip.notify(entry(first!.section, 80, 100, 6))
    start.notify(startEntry(first!.start, 100, 5))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(true)
  })

  it('rebuilds only the strip on viewport height changes and invalidates its old callback', () => {
    const { viewport, groups: [first] } = fixture()
    const { size, strip } = startObserving(viewport)
    strip.notify(entry(first!.section, 80, 100, 1))
    size.notify(viewport)
    size.notify(first!.section, 400)
    expect(intersections).toHaveLength(2)
    size.notify(viewport, 400)
    expect(strip.disconnect).toHaveBeenCalledOnce()
    const replacement = intersections[2]!
    expect(replacement.rootMargin).toBe('0px 0px -399px 0px')
    replacement.notify(entry(first!.section, 100, 100, 2))
    const write = vi.spyOn(first!.heading, 'toggleAttribute')
    strip.notify(entry(first!.section, 80, 100, 100))
    expect(write).not.toHaveBeenCalled()
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    size.notify(viewport, 0.5)
    expect(intersections[3]!.rootMargin).toBe('0px 0px 0px 0px')
    size.notify(viewport, 0)
    expect(intersections[4]!.rootMargin).toBe('0px 0px 0px 0px')
  })

  it('ignores unavailable root bounds and unrelated intersection targets', () => {
    const { viewport, groups: [first] } = fixture()
    const { start, strip } = startObserving(viewport)
    strip.notify(entry(first!.section, 80, 100, 1))
    strip.notify(entry(first!.section, 100, 100, 2, 1, null), entry(viewport, 100, 100, 2))
    start.notify(entry(first!.start, 100, 1, 2, 200, null), startEntry(viewport, 100, 2))
    expect(first!.heading.hasAttribute('data-stuck')).toBe(true)
  })

  it('disconnects every observer, clears only stuck headings, and prevents all late writes', () => {
    const { viewport, groups: [first] } = fixture()
    const { dispose, start, size, strip } = startObserving(viewport)
    strip.notify(entry(first!.section, 80, 100, 1))
    const remove = vi.spyOn(first!.heading, 'removeAttribute')
    dispose()
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    expect(remove).toHaveBeenCalledOnce()
    const write = vi.spyOn(first!.heading, 'toggleAttribute')
    start.notify(startEntry(first!.start, 80, 2))
    strip.notify(entry(first!.section, 80, 100, 2))
    size.notify(viewport, 400)
    dispose()
    expect(intersections).toHaveLength(2)
    expect(write).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledOnce()
    for (const observer of [start, size, strip]) expect(observer.disconnect).toHaveBeenCalledOnce()
  })

  it('can dispose before the first size delivery without constructing a strip observer', () => {
    const { viewport } = fixture()
    const dispose = observe(viewport)
    dispose()
    sizes[0]!.notify(viewport)
    expect(intersections).toHaveLength(1)
    expect(sizes[0]!.disconnect).toHaveBeenCalledOnce()
  })

  it('recaptures filtered groups and rejects callbacks from the previous setup', () => {
    const { viewport, rerender, groups: [first] } = fixture()
    const previous = startObserving(viewport)
    previous.strip.notify(entry(first!.section, 80, 100, 1))
    previous.dispose()
    rerender(<div data-testid="viewport"><MenuGroup label="Filtered"><button type="button">Match</button></MenuGroup></div>)
    const group = screen.getByRole('group', { name: 'Filtered' })
    const heading = directChild(group, 'data-menu-group-heading')
    observe(viewport)
    sizes[1]!.notify(viewport)
    const current = intersections[3]!
    expect(current.observe.mock.calls).toEqual([[group]])
    current.notify(entry(group, 80, 100, 2))
    expect(heading.hasAttribute('data-stuck')).toBe(true)
    const write = vi.spyOn(heading, 'toggleAttribute')
    previous.start.notify(startEntry(first!.start, 100, 3))
    previous.strip.notify(entry(first!.section, 100, 100, 3))
    previous.size.notify(viewport, 400)
    expect(write).not.toHaveBeenCalled()
    expect(heading.hasAttribute('data-stuck')).toBe(true)
    expect(intersections).toHaveLength(4)
  })

  it('observes only direct groups with both direct headings and start sentinels', () => {
    render(<div data-testid="viewport">
      <MenuGroup label="Direct"><MenuGroup label="Nested" /></MenuGroup>
      <section data-menu-group=""><span data-menu-group-start="" /><div><div data-menu-group-heading="">Indirect</div></div></section>
      <section data-menu-group=""><div data-menu-group-heading="">No start</div></section>
      <section><div data-menu-group-heading="">Unmarked</div></section>
    </div>)
    const viewport = screen.getByTestId('viewport')
    const group = screen.getByRole('group', { name: 'Direct' })
    const { start, strip } = startObserving(viewport)
    expect(start.observe.mock.calls).toEqual([[directChild(group, 'data-menu-group-start')]])
    expect(strip.observe.mock.calls).toEqual([[group]])
    strip.notify(entry(group, 80, 100, 1))
    expect(screen.getByText('Direct').hasAttribute('data-stuck')).toBe(true)
    for (const label of ['Nested', 'Indirect', 'No start', 'Unmarked']) {
      expect(screen.getByText(label).hasAttribute('data-stuck')).toBe(false)
    }
  })

  it('acquires no observers or listeners without valid direct groups', () => {
    render(<div data-testid="viewport"><div><MenuGroup label="Nested" /></div><section data-menu-group="" /></div>)
    const viewport = screen.getByTestId('viewport')
    const addScroll = vi.spyOn(viewport, 'addEventListener')
    const addResize = vi.spyOn(window, 'addEventListener')
    const dispose = observe(viewport)
    expect(intersections).toHaveLength(0)
    expect(sizes).toHaveLength(0)
    expect(addScroll).not.toHaveBeenCalled()
    expect(addResize).not.toHaveBeenCalled()
    expect(dispose).not.toThrow()
  })

  it.each(['IntersectionObserver', 'ResizeObserver'])('keeps CSS sticky headings transparent without %s', (api) => {
    vi.stubGlobal(api, undefined)
    const { viewport, groups: [first] } = fixture()
    const read = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    const dispose = observe(viewport)
    viewport.scrollTop = 20
    fireEvent.scroll(viewport)
    fireEvent.resize(window)
    expect(first!.heading.hasAttribute('data-stuck')).toBe(false)
    expect(intersections).toHaveLength(0)
    expect(sizes).toHaveLength(0)
    expect(read).not.toHaveBeenCalled()
    expect(dispose).not.toThrow()
  })
})
