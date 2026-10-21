// @vitest-environment jsdom
/** Chat scroll composition over the real viewport, reading owner, and fold lifecycle. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowMotionRows } from '../src/client/chat/flow-motion.ts'
import { useChatScroll, type ChatScrollInput } from '../src/client/chat/use-chat-scroll.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  try {
    cleanup()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

function ScrollHarness({ input, onMotion }: {
  readonly input: ChatScrollInput
  readonly onMotion: (motion: FlowMotionRows) => void
}) {
  const state = useChatScroll(input)
  useLayoutEffect(() => { onMotion(state.motion) }, [onMotion, state.motion])
  return <>
    <div ref={state.listRef} data-testid="scrollport" data-initialized={state.initialized}>
      <div ref={state.columnRef} data-testid="column" data-chat-flow="" />
      <div data-chat-turn-spacer="" />
    </div>
    <button type="button" onClick={state.returnToBottom}>Return to bottom</button>
  </>
}

function mountScroll(deferCompletedTurns = true, initial: Partial<ChatScrollInput> = {}) {
  let input: ChatScrollInput = {
    ready: true,
    order: [],
    firstSeq: null,
    lastKey: null,
    lastIsUser: false,
    steeringId: null,
    submissionId: null,
    running: false,
    deferCompletedTurns,
    transcriptView: 'verbose',
    loadedTurns: [],
    hasMore: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    loadThrough: vi.fn(async () => {}),
    chatScroll: { read: () => null, save: vi.fn() },
    ...initial,
  }
  const callbacks: { motion?: FlowMotionRows; resize?: () => void } = {}
  class Observer implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { callbacks.resize = () => { callback([], this) } }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void { delete callbacks.resize }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  const onMotion = (motion: FlowMotionRows): void => { callbacks.motion = motion }
  const view = render(<ScrollHarness input={input} onMotion={onMotion} />)
  const scroller = within(view.container).getByTestId('scrollport')
  const spacer = scroller.querySelector<HTMLElement>('[data-chat-turn-spacer]')
  if (spacer === null) throw new Error('Missing fold spacer')
  let height = 1_000
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.behavior === 'instant') scroller.scrollTop = options.top ?? scroller.scrollTop
  })
  Object.defineProperties(scroller, {
    clientHeight: { value: 400 },
    scrollHeight: { get: () => height + (Number.parseFloat(spacer.style.height) || 0) },
    scrollTo: { value: scrollTo },
  })
  const row = document.createElement('div')
  Object.defineProperty(row, 'offsetHeight', { value: 80 })
  within(view.container).getByTestId('column').append(row)
  return {
    view, scroller, scrollTo, row,
    resize: () => { act(() => { callbacks.resize?.() }) },
    grow: (next: number) => { height = next },
    update: (patch: Partial<ChatScrollInput>) => {
      input = { ...input, ...patch }
      view.rerender(<ScrollHarness input={input} onMotion={onMotion} />)
    },
    startFold: () => {
      const motion = callbacks.motion
      if (motion === undefined) throw new Error('Viewport motion callbacks are not bound')
      act(() => { motion.collapse(row, () => { row.hidden = true }) })
    },
    /** Run the fold's frame clock to its end (a row outside a batch finishes on its transition). */
    finishFold: () => {
      const event = new Event('transitionend', { bubbles: true })
      Object.defineProperty(event, 'propertyName', { value: 'height' })
      act(() => {
        row.dispatchEvent(event)
        vi.advanceTimersByTime(200)
      })
    },
  }
}

const visibleFoldCases = [
  { name: 'E/E', earlier: 2400, steps: 1000, body: 400, viewport: 800, top: 800, input: 80, target: 2080, room: 0 },
  { name: 'E/T', earlier: 600, steps: 1000, body: 100, viewport: 800, top: 200, input: 80, target: 200, room: 220 },
  { name: 'E/B', earlier: 500, steps: 200, body: 400, viewport: 800, top: 200, input: 80, target: 200, room: 20 },
  { name: 'T/T', earlier: 500, steps: 2000, body: 100, viewport: 800, top: 900, input: 80, target: 500, room: 620 },
  { name: 'T/B', earlier: 500, steps: 1200, body: 400, viewport: 800, top: 1200, input: 80, target: 500, room: 320 },
  { name: 'B/B', earlier: 2400, steps: 1600, body: 1000, viewport: 800, top: 4200, input: 80, target: 2680, room: 0 },
  { name: 'short content', earlier: 100, steps: 300, body: 100, viewport: 800, top: 0, input: 80, target: 0, room: 0 },
  { name: 'larger input', earlier: 2000, steps: 300, body: 600, viewport: 800, top: 2100, input: 400, target: 2200, room: 0 },
  { name: 'body fills viewport', earlier: 900, steps: 300, body: 800, viewport: 800, top: 1200, input: 40, target: 940, room: 0 },
  { name: 'steps fill viewport', earlier: 900, steps: 800, body: 0, viewport: 800, top: 900, input: 0, target: 900, room: 800 },
  { name: 'input fills visible steps', earlier: 900, steps: 300, body: 500, viewport: 800, top: 900, input: 300, target: 900, room: 0 },
  { name: 'no steps', earlier: 900, steps: 0, body: 500, viewport: 800, top: 600, input: 40, target: 640, room: 0 },
  { name: 'input taller than viewport', earlier: 900, steps: 1200, body: 100, viewport: 800, top: 1400, input: 1200, target: 1400, room: 0 },
  { name: 'small viewport', earlier: 200, steps: 900, body: 100, viewport: 300, top: 900, input: 30, target: 200, room: 170 },
] as const

function mountVisibleFold(test: typeof visibleFoldCases[number], reduced: boolean, finalSiblingGrowth = 0) {
  let inputHeight = 0
  let submission = 0
  let top: number = test.top
  let motion: FlowMotionRows | undefined
  const onMotion = (value: FlowMotionRows): void => { motion = value }
  let input: ChatScrollInput = {
    ready: false, order: [], firstSeq: null, lastKey: null, lastIsUser: false,
    steeringId: null, submissionId: null, running: false, deferCompletedTurns: true,
    transcriptView: 'detailed', loadedTurns: [], hasMore: false, loadingOlder: false,
    loadOlder: vi.fn(), loadThrough: vi.fn(async () => {}), chatScroll: { read: () => null, save: vi.fn() },
  }
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })))
  const view = render(<ScrollHarness input={input} onMotion={onMotion} />)
  const scroller = within(view.container).getByTestId('scrollport')
  const column = within(view.container).getByTestId('column')
  const spacer = scroller.querySelector<HTMLElement>('[data-chat-turn-spacer]')!
  const row = document.createElement('div')
  const glyph = document.createElement('span')
  glyph.textContent = 'step text'
  row.append(glyph)
  column.append(row)
  const rowHeight = () => row.hidden ? 0 : (row.style.transition !== '' && row.style.transition !== 'none') || row.style.height === ''
    ? test.steps : Number.parseFloat(row.style.height)
  const room = () => Number.parseFloat(spacer.style.height) || 0
  const contentHeight = () => test.earlier + rowHeight() + test.body + inputHeight + (row.hidden ? finalSiblingGrowth : 0)
  const floor = () => Math.max(0, contentHeight() + room() - test.viewport)
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    scroller.scrollTop = options.top ?? scroller.scrollTop
  })
  Object.defineProperties(scroller, {
    clientHeight: { get: () => test.viewport },
    scrollHeight: { get: () => Math.max(test.viewport, contentHeight() + room()) },
    scrollTop: {
      get: () => { top = Math.max(0, Math.min(top, floor())); return top },
      set: (value: number) => { top = Math.max(0, Math.min(value, floor())) },
    },
    scrollTo: { value: scrollTo },
    getBoundingClientRect: { value: () => ({ top: 0, bottom: test.viewport, height: test.viewport }) },
  })
  Object.defineProperties(row, {
    offsetHeight: { get: rowHeight },
    getBoundingClientRect: { value: () => ({ top: test.earlier - top, bottom: test.earlier - top + rowHeight(), height: rowHeight() }) },
  })
  Object.defineProperties(column, {
    offsetHeight: { get: contentHeight },
    getBoundingClientRect: { value: () => ({ top: -top, bottom: contentHeight() - top, height: contentHeight() }) },
  })
  input = { ...input, ready: true }
  view.rerender(<ScrollHarness input={input} onMotion={onMotion} />)
  top = test.top
  scrollTo.mockClear()
  return {
    scroller, row, room, scrollTo,
    reopenAll(verbose = false) {
      act(() => { motion?.cancelMotion(row) })
      row.hidden = false
      if (verbose) {
        input = { ...input, transcriptView: 'verbose' }
        view.rerender(<ScrollHarness input={input} onMotion={onMotion} />)
      }
    },
    growDuringFold(height: number, newSubmission: boolean) {
      inputHeight += height
      input = newSubmission
        ? { ...input, submissionId: 'second-distinct-input' }
        : { ...input, order: ['new-stream-content'], running: true }
      view.rerender(<ScrollHarness input={input} onMotion={onMotion} />)
    },
    cancelReading() {
      fireEvent.wheel(scroller, { deltaY: -20 })
      scroller.scrollTop -= 20
      fireEvent.scroll(scroller)
      return scroller.scrollTop
    },
    updateInput() {
      input = { ...input, submissionId: null, lastKey: 'durable-input', lastIsUser: true }
      view.rerender(<ScrollHarness input={input} onMotion={onMotion} />)
    },
    bodyTop: () => test.earlier + rowHeight() - top,
    submit() {
      inputHeight += test.input
      row.hidden = false
      submission++
      act(() => {
        motion?.collapse(row, () => { row.hidden = true })
      })
      input = { ...input, submissionId: `visible-fold-input-${submission}` }
      view.rerender(<ScrollHarness input={input} onMotion={onMotion} />)
    },
  }
}

describe.each([false, true])('visible input-fold matrix (reduced=%s)', (reduced) => {
  it.each(['larger input', 'T/B'])('lands on final sibling spacing in the closing frame (%s)', async (name) => {
    const test = visibleFoldCases.find(test => test.name === name)!
    const h = mountVisibleFold(test, reduced, 4)
    h.submit()
    await act(async () => { await Promise.resolve() })
    for (let frame = 0; frame < 24 && !h.row.hidden; frame++) {
      act(() => { vi.advanceTimersByTime(16) })
    }
    expect(h.row.hidden).toBe(true)
    const target = test.target + (test.room === 0 ? 4 : 0)
    expect(h.scroller.scrollTop).toBe(target)
    expect(h.room()).toBe(Math.max(0, test.room - 4))
    act(() => { vi.advanceTimersByTime(500) })
    expect(h.scroller.scrollTop).toBe(target)
  })

  it.each(visibleFoldCases)('$name lands with only the required visible room', async (test) => {
    const h = mountVisibleFold(test, reduced)
    const positions = [h.bodyTop()]
    h.submit()
    await act(async () => { await Promise.resolve() })
    for (let frame = 0; frame < 24; frame++) {
      act(() => { vi.advanceTimersByTime(16) })
      positions.push(h.bodyTop())
    }
    expect(h.scroller.scrollTop).toBeCloseTo(test.target, 5)
    expect(h.room()).toBeCloseTo(test.room, 5)
    if (test.steps > 0) expect(h.scrollTo.mock.calls.some(([options]) => options.behavior === 'smooth')).toBe(false)
    for (let i = 1; i < positions.length; i++) expect(positions[i]!).toBeLessThanOrEqual(positions[i - 1]! + 0.01)
    const end = h.bodyTop()
    act(() => { vi.advanceTimersByTime(500) })
    expect(h.bodyTop()).toBe(end)
  })
})

it('consumes a prior legal fold deficit instead of accumulating whole steps on the next input', async () => {
  const test = visibleFoldCases.find(test => test.name === 'T/B')!
  const h = mountVisibleFold(test, false)
  h.submit()
  await act(async () => { await Promise.resolve() })
  act(() => { vi.advanceTimersByTime(400) })
  expect(h.room()).toBe(320)
  h.submit()
  await act(async () => { await Promise.resolve() })
  act(() => { vi.advanceTimersByTime(400) })
  expect(h.scroller.scrollTop).toBe(500)
  expect(h.room()).toBe(240)
  expect(h.scrollTo).not.toHaveBeenCalled()
})

it('retains the reader position without clamping after an input fold is interrupted', async () => {
  const test = visibleFoldCases.find(test => test.name === 'B/B')!
  const h = mountVisibleFold(test, false)
  h.submit()
  await act(async () => { await Promise.resolve() })
  act(() => { vi.advanceTimersByTime(112) })
  const readingTop = h.cancelReading()
  act(() => { vi.advanceTimersByTime(400) })
  expect(h.scroller.scrollTop).toBe(readingTop)
  expect(h.scrollTo.mock.calls.some(([options]) => options.behavior === 'smooth')).toBe(false)
})

it.each([false, true])('stops obsolete viewport writes when every closing row reopens (verbose=%s)', async (verbose) => {
  const test = visibleFoldCases.find(test => test.name === 'T/B')!
  const h = mountVisibleFold(test, false)
  h.submit()
  await act(async () => { await Promise.resolve() })
  act(() => { vi.advanceTimersByTime(112) })
  h.reopenAll(verbose)
  await act(async () => { await Promise.resolve() })
  const position = h.scroller.scrollTop
  act(() => { vi.advanceTimersByTime(400) })
  expect(h.room()).toBe(0)
  expect(h.scroller.scrollTop).toBe(position)
  expect(h.row.hidden).toBe(false)
  expect(h.row.style.height).toBe('')
  expect(h.scroller.querySelector('[data-input-fold]')).toBeNull()
  expect(h.scrollTo.mock.calls.some(([options]) => options.behavior === 'smooth')).toBe(false)
})

it.each([false, true])('absorbs new height before the active fold finishes (new submission=%s)', async (newSubmission) => {
  const test = visibleFoldCases.find(test => test.name === 'B/B')!
  const h = mountVisibleFold(test, false)
  h.submit()
  await act(async () => { await Promise.resolve() })
  act(() => { vi.advanceTimersByTime(112) })
  h.growDuringFold(320, newSubmission)
  await act(async () => { await Promise.resolve() })
  const positions = [h.bodyTop()]
  for (let frame = 0; frame < 12; frame++) {
    act(() => { vi.advanceTimersByTime(16) })
    positions.push(h.bodyTop())
  }
  expect(h.scroller.scrollTop).toBe(test.target + 320)
  expect(h.room()).toBe(0)
  for (let i = 1; i < positions.length; i++) expect(positions[i]!).toBeLessThanOrEqual(positions[i - 1]! + 0.01)
  const settled = h.scroller.scrollTop
  act(() => { vi.advanceTimersByTime(500) })
  expect(h.scroller.scrollTop).toBe(settled)
  expect(h.scrollTo.mock.calls.some(([options]) => options.behavior === 'smooth')).toBe(false)
})

it('keeps one active fold when the local echo becomes its durable input', async () => {
  const test = visibleFoldCases.find(test => test.name === 'B/B')!
  const h = mountVisibleFold(test, false)
  h.submit()
  await act(async () => { await Promise.resolve() })
  act(() => { vi.advanceTimersByTime(96) })
  const halfway = h.bodyTop()
  h.updateInput()
  await act(async () => { await Promise.resolve() })
  act(() => { vi.advanceTimersByTime(400) })
  expect(h.scroller.scrollTop).toBe(test.target)
  expect(h.room()).toBe(0)
  expect(h.bodyTop()).toBeLessThanOrEqual(halfway)
  expect(h.scrollTo.mock.calls.some(([options]) => options.behavior === 'smooth')).toBe(false)
})

describe('Chat scroll collapse timing', () => {
  it.each(['resize', 'scroll', 'history', 'input', 'preference'] as const)(
    'waits for initial history before initializing a running view after %s', (change) => {
      const h = mountScroll(true, { ready: false, running: true })
      expect(h.scroller.dataset.initialized).toBe('false')
      if (change === 'resize') h.resize()
      else if (change === 'scroll') fireEvent.scroll(h.scroller)
      else if (change === 'history') h.update({ order: ['history'], lastKey: 'history' })
      else if (change === 'input') h.update({ submissionId: 'pending-input' })
      else h.update({ transcriptView: 'standard' })
      expect(h.scroller.dataset.initialized).toBe('false')
      expect(h.scroller.scrollTop).toBe(0)
      expect(h.scrollTo).not.toHaveBeenCalled()

      h.update({ ready: true })
      expect(h.scroller.dataset.initialized).toBe('true')
      expect(h.scroller.scrollTop).toBe(600)
      expect(h.scrollTo).not.toHaveBeenCalled()
      h.grow(1_200)
      h.resize()
      expect(h.scroller.scrollTop).toBe(800)
    },
  )

  it('does not defer one viewport\'s submitted input behind another viewport\'s fold', () => {
    const first = mountScroll()
    const second = mountScroll()
    first.startFold()
    second.update({ submissionId: 'second-view-input' })
    expect(second.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: 'smooth' })
    expect(second.scroller.style.overflowAnchor).toBe('')
    first.finishFold()
    expect(second.scrollTo).toHaveBeenCalledTimes(1)
    expect(first.scrollTo).not.toHaveBeenCalled()
  })

  it.each([false, true])('follows submitted input with deferCompletedTurns=%s', (deferred) => {
    const h = mountScroll(deferred)
    h.update({ submissionId: 'first' })
    if (deferred) {
      expect(h.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: 'smooth' })
      expect(h.scroller.scrollTop).toBe(0)
    } else {
      expect(h.scrollTo).not.toHaveBeenCalled()
      expect(h.scroller.scrollTop).toBe(600)
    }
  })

  it('coalesces submitted inputs into one frame-owned fold', async () => {
    const h = mountScroll()
    h.startFold()
    h.update({ submissionId: 'first' })
    h.update({ submissionId: 'second' })
    expect(h.scrollTo).not.toHaveBeenCalled()
    expect(h.scroller.scrollTop).toBe(0)
    await act(async () => { await Promise.resolve() })
    // The folded row leaves the committed layout; the landing reads the actual content height.
    h.grow(920)
    act(() => { vi.advanceTimersByTime(400) })
    expect(h.scrollTo).not.toHaveBeenCalled()
    expect(h.scroller.scrollTop).toBe(520)
    expect(h.scroller.style.overflowAnchor).toBe('')
  })

  it('keeps only the visible deficit when submitted input is smaller than the fold', async () => {
    const test = visibleFoldCases.find(test => test.name === 'T/B')!
    const h = mountVisibleFold(test, false)
    h.submit()
    await act(async () => { await Promise.resolve() })
    act(() => { vi.advanceTimersByTime(400) })
    expect(h.scroller.scrollTop).toBe(500)
    expect(h.room()).toBe(320)
    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it.each([false, true])('clears mode-change bottom space after the fold (reader interrupts=%s)', async (interrupt) => {
    const h = mountScroll()
    h.resize()
    h.startFold()
    h.update({ transcriptView: 'standard' })
    await act(async () => { await Promise.resolve() })
    const spacer = h.scroller.querySelector<HTMLElement>('[data-chat-turn-spacer]')!
    expect(spacer.style.height).toBe('80px')
    h.grow(920)
    if (interrupt) {
      fireEvent.wheel(h.scroller, { deltaY: -100 })
      h.scroller.scrollTop = 400
      fireEvent.scroll(h.scroller)
    }
    h.finishFold()
    expect(spacer.style.height).toBe('')
    expect(h.scroller.scrollHeight).toBe(920)
    expect(h.scroller.scrollTop).toBe(interrupt ? 400 : 520)
    expect(h.row.hidden).toBe(true)
    h.resize()
    expect(spacer.style.height).toBe('')
  })

  it('clears a previous fold reservation on an idle mode change', async () => {
    const h = mountScroll()
    h.resize()
    h.startFold()
    await act(async () => { await Promise.resolve() })
    h.grow(920)
    h.finishFold()
    h.resize()
    expect(h.scroller.querySelector<HTMLElement>('[data-chat-turn-spacer]')!.style.height).toBe('80px')
    h.update({ transcriptView: 'standard' })
    expect(h.scroller.querySelector<HTMLElement>('[data-chat-turn-spacer]')!.style.height).toBe('')
    expect(h.scroller.scrollTop).toBe(520)
  })

  it('keeps the latest mode reset when preferences change before a fold finishes', async () => {
    const h = mountScroll()
    h.resize()
    h.startFold()
    h.update({ transcriptView: 'standard' })
    await act(async () => { await Promise.resolve() })
    h.update({ transcriptView: 'detailed' })
    h.grow(920)
    h.finishFold()
    expect(h.scroller.querySelector<HTMLElement>('[data-chat-turn-spacer]')!.style.height).toBe('')
    expect(h.scroller.scrollTop).toBe(520)
  })

  it('combines the remaining input distance with the smaller fold', async () => {
    const test = visibleFoldCases.find(test => test.name === 'larger input')!
    const h = mountVisibleFold(test, false)
    h.submit()
    await act(async () => { await Promise.resolve() })
    act(() => { vi.advanceTimersByTime(400) })
    expect(h.scroller.scrollTop).toBe(2200)
    expect(h.room()).toBe(0)
    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'] as const)(
    'cancels queued follow when the reader sends %s input', async (intent) => {
      const h = mountScroll()
      h.startFold()
      h.update({ submissionId: 'first' })
      await act(async () => { await Promise.resolve() })
      if (intent === 'wheel') fireEvent.wheel(h.scroller, { deltaY: -80 })
      else if (intent === 'touchstart') fireEvent.touchStart(h.scroller)
      else if (intent === 'pointerdown') fireEvent.pointerDown(h.scroller, { button: 0 })
      else fireEvent.keyDown(h.scroller, { key: 'ArrowUp' })
      h.finishFold()
      act(() => { vi.runAllTimers() })
      expect(h.scrollTo).not.toHaveBeenCalled()
      expect(h.scroller.scrollTop).toBe(0)
    },
  )

  it.each([false, true])('keeps a fold cancelled through resize until new input owns follow (new input=%s)', async (newInput) => {
    const h = mountScroll()
    h.scroller.scrollTop = 500
    h.startFold()
    h.update({ submissionId: 'first' })
    await act(async () => { await Promise.resolve() })
    fireEvent.wheel(h.scroller, { deltaY: -80 })
    h.scroller.scrollTop = 420
    fireEvent.scroll(h.scroller)
    h.resize()
    h.update({ order: ['streaming-change'], running: true })
    if (newInput) h.update({ submissionId: 'second' })
    h.grow(920)
    h.finishFold()
    await act(async () => { await Promise.resolve() })
    act(() => { vi.advanceTimersByTime(400) })
    if (newInput) expect(h.scroller.scrollTop).toBe(520)
    else {
      expect(h.scrollTo).not.toHaveBeenCalled()
      expect(h.scroller.scrollTop).toBe(420)
      act(() => { vi.advanceTimersByTime(500) })
      h.resize()
      expect(h.scrollTo).not.toHaveBeenCalled()
      expect(h.scroller.scrollTop).toBe(420)
    }
  })

  it('keeps intent cancellation through a resize before the first scroll delivery', () => {
    const h = mountScroll()
    h.startFold()
    h.update({ submissionId: 'first' })
    fireEvent.wheel(h.scroller, { deltaY: -80 })
    h.resize()
    h.finishFold()
    expect(h.scrollTo).not.toHaveBeenCalled()
    h.update({ submissionId: 'second' })
    expect(h.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: 'smooth' })
  })

  it('does not let process-body scrollend settle an outer native follow', () => {
    const h = mountScroll()
    const body = document.createElement('div')
    body.dataset.stepProcessBody = ''
    h.row.append(body)
    h.update({ submissionId: 'first' })
    h.scroller.scrollTop = 150
    fireEvent.scroll(h.scroller)
    fireEvent(body, new Event('scrollend', { bubbles: true }))
    h.grow(1_200)
    h.resize()
    expect(h.scrollTo.mock.calls).toEqual([
      [{ top: 600, behavior: 'smooth' }],
      [{ top: 800, behavior: 'smooth' }],
    ])
    h.scroller.scrollTop = 800
    fireEvent.scroll(h.scroller)
    fireEvent(h.scroller, new Event('scrollend'))
    h.grow(1_300)
    h.resize()
    expect(h.scroller.scrollTop).toBe(900)
  })

  it('cancels queued follow when the Chat view unmounts', () => {
    const h = mountScroll()
    h.startFold()
    h.update({ submissionId: 'first' })
    h.view.unmount()
    h.finishFold()
    act(() => { vi.runAllTimers() })
    expect(h.scrollTo).not.toHaveBeenCalled()
    expect(h.scroller.scrollTop).toBe(0)
    expect(h.scroller.style.overflowAnchor).toBe('')
  })

  it('does not revive a cancelled follow when delayed timing is re-enabled before the fold ends', () => {
    const h = mountScroll()
    h.startFold()
    h.update({ submissionId: 'first' })
    h.update({ deferCompletedTurns: false })
    h.update({ deferCompletedTurns: true })
    h.finishFold()
    act(() => { vi.runAllTimers() })
    expect(h.scrollTo).not.toHaveBeenCalled()
    expect(h.scroller.scrollTop).toBe(0)
    h.update({ deferCompletedTurns: false, submissionId: 'second' })
    expect(h.scroller.scrollTop).toBe(600)
    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it('returns to bottom immediately and cancels an older fold waiter', () => {
    const h = mountScroll()
    h.startFold()
    h.update({ submissionId: 'first' })
    fireEvent.click(h.view.getByRole('button', { name: 'Return to bottom' }))
    expect(h.scroller.scrollTop).toBe(600)
    h.grow(1_200)
    h.finishFold()
    expect(h.scroller.scrollTop).toBe(600)
    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it('interrupts an active smooth follow when completion timing is restored', () => {
    const h = mountScroll()
    h.update({ submissionId: 'first' })
    h.scroller.scrollTop = 150
    h.update({ deferCompletedTurns: false })
    expect(h.scrollTo).toHaveBeenLastCalledWith({ top: 150, behavior: 'instant' })
    expect(h.scroller.scrollTop).toBe(150)
    h.update({ submissionId: 'second' })
    expect(h.scroller.scrollTop).toBe(600)
    expect(h.scrollTo).toHaveBeenCalledTimes(2)
  })
})
