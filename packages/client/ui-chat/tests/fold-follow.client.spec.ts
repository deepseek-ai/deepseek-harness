// @vitest-environment jsdom
/** Recorded layout arithmetic supplements browser geometry; no browser layout is asserted here. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'
import { ChatReading } from '../src/client/chat/use-chat-reading.ts'
import { ScrollFollow } from '../src/client/chat/use-scroll-follow.ts'

const disposers = new Set<() => void>()
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(async () => {
  try {
    for (const dispose of disposers) dispose()
    disposers.clear()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

function fixture() {
  const list = document.createElement('div')
  const column = document.createElement('div')
  const row = document.createElement('div')
  const spacer = document.createElement('div')
  spacer.dataset.chatTurnSpacer = ''
  column.append(row)
  list.append(column, spacer)
  document.body.append(list)
  let contentHeight = 2_400
  let top = 2_000
  const room = () => Number.parseFloat(spacer.style.height) || 0
  const floor = () => Math.max(0, contentHeight + room() - 400)
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.behavior === 'instant') list.scrollTop = options.top ?? list.scrollTop
  })
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => Math.max(400, contentHeight + room()) },
    scrollTop: {
      configurable: true,
      get: () => { top = Math.min(top, floor()); return top },
      set: (value: number) => { top = Math.max(0, Math.min(value, floor())) },
    },
    scrollTo: { value: scrollTo },
  })
  Object.defineProperty(row, 'offsetHeight', { value: 1_800 })
  const viewport = new ChatViewport()
  viewport.attach(list, column)
  const follow = new ScrollFollow(true, 25)
  const reading = new ChatReading(viewport, { read: () => null, save: vi.fn() }, {
    initialized: true, followingTail: true, activeTurn: 1,
  }, vi.fn(), follow)
  viewport.connect({
    scroll: reading.onScroll,
    scrollEnd: reading.onScrollEnd,
    resize: () => { reading.onResize() },
    interact: () => {},
    intent: () => { reading.interruptFollow() },
  })
  disposers.add(() => {
    reading.dispose()
    viewport.detach()
    list.remove()
  })
  return {
    list, spacer, row, viewport, follow, reading, scrollTo,
    grow: (height: number) => { contentHeight = height },
    close: async () => {
      viewport.motion.collapse(row, () => { row.hidden = true })
      await Promise.resolve()
      contentHeight -= 1_800
      expect(list.scrollTop).toBe(2_000)
      const event = new Event('transitionend')
      Object.defineProperty(event, 'propertyName', { value: 'height' })
      row.dispatchEvent(event)
    },
    scroll: (value: number) => {
      list.scrollTop = value
      list.dispatchEvent(new Event('scroll'))
    },
  }
}

it('retains fold room and lets content growth consume it without reversing the scrollport', async () => {
  const h = fixture()
  await h.close()
  h.viewport.reclaimBelow()
  h.reading.followTail('smooth')
  expect(h.list.scrollTop).toBe(2_000)
  expect(h.spacer.style.height).toBe('1800px')
  expect(h.scrollTo).not.toHaveBeenCalled()
  h.grow(1_000)
  h.viewport.reclaimBelow()
  h.reading.onResize()
  expect(h.list.scrollTop).toBe(2_000)
  expect(h.spacer.style.height).toBe('1400px')
  h.grow(2_400)
  h.viewport.reclaimBelow()
  h.reading.onResize()
  expect(h.list.scrollTop).toBe(2_000)
  expect(h.spacer.style.height).toBe('')
  h.grow(2_520)
  h.reading.onResize()
  expect(h.list.scrollTop).toBe(2_120)
  expect(h.follow.animating).toBe(false)
})

it('keeps manual off-bottom ownership and reclaims only space below the reader', async () => {
  const h = fixture()
  await h.close()
  h.reading.followTail('smooth')
  h.scroll(1_000)
  h.list.dispatchEvent(new Event('wheel'))
  h.scroll(900)
  vi.advanceTimersByTime(500)
  expect(h.reading.followingTail).toBe(false)
  expect(h.spacer.style.height).toBe('700px')
  h.viewport.reclaimBelow()
  h.reading.onResize()
  expect(h.list.scrollTop).toBe(900)
  expect(h.spacer.style.height).toBe('700px')
  expect(h.follow.animating).toBe(false)
})

it('retains existing fold room when reduced-motion following has no forward distance', async () => {
  const h = fixture()
  await h.close()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  h.reading.followTail('smooth')
  expect(h.list.scrollTop).toBe(2_000)
  expect(h.spacer.style.height).toBe('1800px')
  expect(h.follow.animating).toBe(false)
})

it.each([1_999.5, 2_000, 2_000.5])('restores follow immediately at a rounded floor sample (%s)', (top) => {
  const h = fixture()
  h.reading.pauseFollowing()
  h.reading.onScroll({ metrics: { top, floor: 2_000, height: 400 }, movedByReader: true })
  expect(h.reading.followingTail).toBe(true)
  expect(h.reading.pending).toBe(false)
})

it.each([1_999, 2_001])('keeps movement at least one pixel from the floor pending (%s)', (top) => {
  const h = fixture()
  h.reading.pauseFollowing()
  h.reading.onScroll({ metrics: { top, floor: 2_000, height: 400 }, movedByReader: true })
  expect(h.reading.followingTail).toBe(false)
  expect(h.reading.pending).toBe(true)
})

it('does not measure geometry to interrupt an idle follow controller', () => {
  const h = fixture()
  const reads = (['clientHeight', 'scrollHeight', 'scrollTop'] as const).map(property =>
    vi.spyOn(h.list, property, 'get'))
  h.viewport.interruptFollow(h.follow)
  for (const read of reads) expect(read).not.toHaveBeenCalled()
})
