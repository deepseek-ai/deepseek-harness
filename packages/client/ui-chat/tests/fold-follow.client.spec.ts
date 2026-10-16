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

const frames = new Map<number, FrameRequestCallback>()
let frameClock = 0
let nextFrame = 0

/** Run a fixed number of queued animation frames. */
function runFrameCount(count: number): void {
  for (let index = 0; index < count && frames.size > 0; index++) {
    const pending = [...frames.values()]
    frames.clear()
    frameClock += 16
    for (const callback of pending) callback(frameClock)
  }
}

/** Run queued animation frames until the batch stops requesting more. */
function runFrames(): void {
  for (let guard = 0; frames.size > 0 && guard < 100; guard++) {
    const pending = [...frames.values()]
    frames.clear()
    frameClock += 16
    for (const callback of pending) callback(frameClock)
  }
}

/**
 * Earlier content, one closing row, and later content in a 400px scrollport.
 * @param layout - heights above and below the row and the starting scroll position.
 */
function fixture(layout: { earlier: number; later: number; top: number; following: boolean }) {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const list = document.createElement('div')
  const column = document.createElement('div')
  const row = document.createElement('div')
  const spacer = document.createElement('div')
  spacer.dataset.chatTurnSpacer = ''
  column.append(row)
  list.append(column, spacer)
  document.body.append(list)
  let contentHeight = layout.earlier + 1_800 + layout.later
  let top = layout.top
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
    getBoundingClientRect: { value: () => ({ top: 0, bottom: 400, height: 400 }) },
  })
  Object.defineProperty(column, 'offsetHeight', { get: () => contentHeight })
  Object.defineProperties(row, {
    offsetHeight: { value: 1_800 },
    getBoundingClientRect: { value: () => ({ top: layout.earlier - top, bottom: layout.earlier - top + 1_800, height: 1_800 }) },
  })
  const viewport = new ChatViewport()
  viewport.attach(list, column)
  const follow = new ScrollFollow(layout.following, 25)
  const reading = new ChatReading(viewport, { read: () => null, save: vi.fn() }, {
    initialized: true, followingTail: layout.following, activeTurn: 1,
  }, vi.fn(), follow)
  const unbind = reading.bindFolds()
  viewport.connect({
    scroll: reading.onScroll,
    scrollEnd: reading.onScrollEnd,
    resize: () => { reading.onResize() },
    interact: () => {},
    intent: () => { reading.interruptFollow() },
  })
  disposers.add(() => {
    unbind()
    reading.dispose()
    viewport.detach()
    list.remove()
    frames.clear()
  })
  return {
    list, spacer, row, viewport, follow, reading, scrollTo,
    grow: (height: number) => { contentHeight = height },
    close: async () => {
      viewport.motion.collapse(row, () => {
        row.hidden = true
        contentHeight -= 1_800
      })
      await Promise.resolve()
      runFrames()
    },
    scroll: (value: number) => {
      list.scrollTop = value
      list.dispatchEvent(new Event('scroll'))
    },
  }
}

/** The row is partly on screen: content above the reading line never slides back, so room remains. */
const VISIBLE_ROW = { earlier: 600, later: 0, top: 2_000, following: true }

it('lands a following reader at the tail and lets content growth consume the room it keeps', async () => {
  const h = fixture(VISIBLE_ROW)
  await h.close()
  expect(h.list.scrollTop).toBe(600)
  expect(h.spacer.style.height).toBe('400px')
  expect(h.reading.followingTail).toBe(true)
  expect(h.scrollTo).not.toHaveBeenCalled()
  h.grow(800)
  h.viewport.reclaimBelow()
  h.reading.onResize()
  expect(h.list.scrollTop).toBe(600)
  expect(h.spacer.style.height).toBe('200px')
  h.grow(1_000)
  h.viewport.reclaimBelow()
  h.reading.onResize()
  expect(h.list.scrollTop).toBe(600)
  expect(h.spacer.style.height).toBe('')
  h.grow(1_120)
  h.reading.onResize()
  expect(h.list.scrollTop).toBe(720)
  expect(h.follow.animating).toBe(false)
})

it('adds a reader\'s own scrolling during the fold to the position it keeps still', async () => {
  const h = fixture({ earlier: 100, later: 500, top: 2_000, following: false })
  h.viewport.motion.collapse(h.row, () => { h.row.hidden = true; h.grow(600) })
  await Promise.resolve()
  runFrameCount(6)
  h.list.scrollTop -= 50
  runFrames()
  expect(h.list.scrollTop).toBe(150)
  expect(h.reading.followingTail).toBe(false)
})

it('keeps the reader landing while reader movement awaits sampling', async () => {
  const h = fixture({ earlier: 100, later: 500, top: 2_000, following: true })
  h.list.dispatchEvent(new Event('wheel'))
  h.scroll(1_990)
  expect(h.reading.pending).toBe(true)
  h.viewport.motion.collapse(h.row, () => { h.row.hidden = true; h.grow(600) })
  await Promise.resolve()
  runFrames()
  expect(h.list.scrollTop).toBe(190)
  vi.advanceTimersByTime(500)
})

it('lands a tail batch on the committed content when it reaches past the estimate', async () => {
  const h = fixture(VISIBLE_ROW)
  // Content arriving with the hidden commit is not in the estimate; the landing reads the real floor.
  h.viewport.motion.collapse(h.row, () => { h.row.hidden = true; h.grow(1_200) })
  await Promise.resolve()
  runFrames()
  expect(h.list.scrollTop).toBe(800)
  expect(h.spacer.style.height).toBe('')
  expect(h.reading.followingTail).toBe(true)
})

it('keeps a reader below folding rows on the same content without room or follow', async () => {
  const h = fixture({ earlier: 100, later: 500, top: 2_000, following: false })
  await h.close()
  expect(h.list.scrollTop).toBe(200)
  expect(h.spacer.style.height).toBe('')
  expect(h.reading.followingTail).toBe(false)
  expect(h.reading.pending).toBe(false)
})

it('keeps manual off-bottom ownership and reclaims only space below the reader', async () => {
  const h = fixture(VISIBLE_ROW)
  await h.close()
  h.list.dispatchEvent(new Event('wheel'))
  h.scroll(300)
  vi.advanceTimersByTime(500)
  expect(h.reading.followingTail).toBe(false)
  expect(h.spacer.style.height).toBe('100px')
  h.viewport.reclaimBelow()
  h.reading.onResize()
  runFrames()
  expect(h.list.scrollTop).toBe(300)
  expect(h.spacer.style.height).toBe('100px')
  expect(h.follow.animating).toBe(false)
})

it('lands immediately under reduced motion', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  const h = fixture(VISIBLE_ROW)
  h.viewport.motion.collapse(h.row, () => { h.row.hidden = true; h.grow(600) })
  await Promise.resolve()
  expect(h.list.scrollTop).toBe(600)
  expect(h.spacer.style.height).toBe('400px')
  expect(h.follow.animating).toBe(false)
})

it.each([1_999.5, 2_000, 2_000.5])('restores follow immediately at a rounded floor sample (%s)', (top) => {
  const h = fixture(VISIBLE_ROW)
  h.reading.pauseFollowing()
  h.reading.onScroll({ metrics: { top, floor: 2_000, height: 400 }, movedByReader: true })
  expect(h.reading.followingTail).toBe(true)
  expect(h.reading.pending).toBe(false)
})

it.each([1_999, 2_001])('keeps movement at least one pixel from the floor pending (%s)', (top) => {
  const h = fixture(VISIBLE_ROW)
  h.reading.pauseFollowing()
  h.reading.onScroll({ metrics: { top, floor: 2_000, height: 400 }, movedByReader: true })
  expect(h.reading.followingTail).toBe(false)
  expect(h.reading.pending).toBe(true)
})

it('does not measure geometry to interrupt an idle follow controller', () => {
  const h = fixture(VISIBLE_ROW)
  const reads = (['clientHeight', 'scrollHeight', 'scrollTop'] as const).map(property =>
    vi.spyOn(h.list, property, 'get'))
  h.viewport.interruptFollow(h.follow)
  for (const read of reads) expect(read).not.toHaveBeenCalled()
})
