// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { AttachmentRail } from '../src/AttachmentRail.tsx'
import type { AttachmentRailItem, AttachmentRailLabels } from '../src/AttachmentRail.tsx'

afterEach(cleanup)

// jsdom implements no ResizeObserver; the stub records instances so a test
// can drive the size-change recompute path.
const observers: { callback: ResizeObserverCallback; observed: Element[] }[] = []
beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', class {
    observed: Element[] = []
    constructor(callback: ResizeObserverCallback) {
      observers.push({ callback, observed: this.observed })
    }

    observe(el: Element) { this.observed.push(el) }
    disconnect() { this.observed.length = 0 }
  })
})
afterEach(() => { vi.unstubAllGlobals() })

const labels: AttachmentRailLabels = {
  group: '待发送图片',
  scrollLeft: '向左滚动图片',
  scrollRight: '向右滚动图片',
}

function item(id: string): AttachmentRailItem {
  return { id }
}

const renderItem = (entry: AttachmentRailItem) => <span>{entry.id}</span>

/** Stub the rail's scroll geometry (jsdom reports 0 for every metric). */
function stubGeometry(rail: HTMLElement, { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(rail, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(rail, 'clientWidth', { value: clientWidth, configurable: true })
  let scrollLeft = 0
  Object.defineProperty(rail, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => { scrollLeft = value },
  })
  const scrollBy = vi.fn((options: { left: number }) => {
    scrollLeft = Math.max(0, Math.min(scrollWidth - clientWidth, scrollLeft + options.left))
  })
  rail.scrollBy = scrollBy as unknown as typeof rail.scrollBy
  return { scrollBy, setScrollLeft: (value: number) => { scrollLeft = value } }
}

describe('AttachmentRail', () => {
  it('renders owner-provided attachment cards in order', () => {
    const items = [item('a'), item('b')]
    const view = render(<AttachmentRail items={items} labels={labels} renderItem={renderItem} />)
    const rail = view.getByRole('group', { name: '待发送图片' })
    expect([...rail.children].map(child => child.textContent)).toEqual(['a', 'b'])
  })

  it('shows edge arrows from scroll geometry and pages a viewport at a time', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b'), item('c')]} labels={labels} renderItem={renderItem} />,
    )
    const rail = view.getByRole('group', { name: '待发送图片' })
    const { scrollBy } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    // No arrows until geometry is observed (mount saw jsdom's zero metrics).
    expect(view.queryByLabelText('向右滚动图片')).toBeNull()
    fireEvent.scroll(rail)
    // Same-edges scroll takes the memoized-state path.
    fireEvent.scroll(rail)
    expect(view.queryByLabelText('向左滚动图片')).toBeNull()
    const right = view.getByLabelText('向右滚动图片')
    // clientWidth 200 - 64 < the 200 floor: pages by the floor.
    fireEvent.click(right)
    expect(scrollBy).toHaveBeenCalledWith({ left: 200, behavior: 'smooth' })
    fireEvent.scroll(rail)
    // Scrolled to the far edge: only the left arrow remains.
    expect(view.queryByLabelText('向右滚动图片')).toBeNull()
    fireEvent.click(view.getByLabelText('向左滚动图片'))
    expect(scrollBy).toHaveBeenCalledWith({ left: -200, behavior: 'smooth' })
    fireEvent.scroll(rail)
    expect(view.queryByLabelText('向左滚动图片')).toBeNull()
    expect(view.getByLabelText('向右滚动图片')).toBeTruthy()
  })

  it('shows both arrows mid-scroll and recomputes when the rail itself resizes', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b'), item('c')]} labels={labels} renderItem={renderItem} />,
    )
    const rail = view.getByRole('group', { name: '待发送图片' })
    const { setScrollLeft } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    setScrollLeft(100)
    // The component observes the rail element, not the window: a sidebar or
    // panel resize reaches it through the ResizeObserver callback.
    expect(observers.at(-1)?.observed).toContain(rail)
    act(() => { observers.at(-1)!.callback([], undefined as never) })
    expect(view.getByLabelText('向左滚动图片')).toBeTruthy()
    expect(view.getByLabelText('向右滚动图片')).toBeTruthy()
  })

  it('keeps scrolling available when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const view = render(
      <AttachmentRail items={[item('a')]} labels={labels} renderItem={renderItem} />,
    )
    expect(view.getByRole('group', { name: '待发送图片' })).toBeTruthy()
    view.unmount()
  })

  it('pans horizontally on a vertical wheel, consuming the event, with clamped normalized travel', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b')]} labels={labels} renderItem={renderItem} />,
    )
    const rail = view.getByRole('group', { name: '待发送图片' })
    const { scrollBy } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    // Converted ticks are consumed (preventDefault): fireEvent returns false.
    expect(fireEvent.wheel(rail, { deltaY: 30 })).toBe(false)
    expect(scrollBy).toHaveBeenCalledWith({ left: 30, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: 500 })
    expect(scrollBy).toHaveBeenCalledWith({ left: 60, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: -500 })
    expect(scrollBy).toHaveBeenCalledWith({ left: -60, behavior: 'auto' })
    // Firefox notch wheels report lines; a page-mode wheel reports viewports.
    fireEvent.wheel(rail, { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect(scrollBy).toHaveBeenCalledWith({ left: 32, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE })
    expect(scrollBy).toHaveBeenCalledWith({ left: -60, behavior: 'auto' })
    // A diagonal pan is consumed too — nothing vertical may escape the rail —
    // and keeps its horizontal intent.
    expect(fireEvent.wheel(rail, { deltaX: 12, deltaY: 30 })).toBe(false)
    expect(scrollBy).toHaveBeenCalledWith({ left: 12, behavior: 'auto' })
    // A purely horizontal pan and a zero-delta wheel keep native behavior.
    expect(fireEvent.wheel(rail, { deltaX: 12, deltaY: 0 })).toBe(true)
    fireEvent.wheel(rail, { deltaY: 0 })
    expect(scrollBy).toHaveBeenCalledTimes(6)
  })

  it('pages instantly under a reduced-motion preference, smoothly otherwise', () => {
    for (const [matches, behavior] of [[true, 'auto'], [false, 'smooth']] as const) {
      vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
      const view = render(
        <AttachmentRail items={[item('a'), item('b'), item('c')]} labels={labels} renderItem={renderItem} />,
      )
      const rail = view.getByRole('group', { name: '待发送图片' })
      const { scrollBy } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
      fireEvent.scroll(rail)
      fireEvent.click(view.getByLabelText('向右滚动图片'))
      expect(scrollBy).toHaveBeenCalledWith({ left: 200, behavior })
      view.unmount()
    }
  })

  it('reveals the rail end when an item is added, not when one is removed', () => {
    const first = [item('a'), item('b')]
    const view = render(
      <AttachmentRail items={first} labels={labels} renderItem={renderItem} />,
    )
    const rail = view.getByRole('group', { name: '待发送图片' })
    stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    view.rerender(
      <AttachmentRail items={[...first, item('c')]} labels={labels} renderItem={renderItem} />,
    )
    expect(rail.scrollLeft).toBe(200)
    view.rerender(
      <AttachmentRail items={first} labels={labels} renderItem={renderItem} />,
    )
    // Removal keeps the position; only growth jumps to the end.
    expect(rail.scrollLeft).toBe(200)
  })
})
