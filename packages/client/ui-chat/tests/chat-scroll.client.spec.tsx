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
    <div ref={state.listRef} data-testid="scrollport">
      <div ref={state.columnRef} data-testid="column" data-chat-flow="" />
      <div data-chat-turn-spacer="" />
    </div>
    <button type="button" onClick={state.returnToBottom}>Return to bottom</button>
  </>
}

function mountScroll(deferCompletedTurns = true) {
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
    loadedTurns: [],
    hasMore: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    loadThrough: vi.fn(async () => {}),
    chatScroll: { read: () => null, save: vi.fn() },
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
    finishFold: () => {
      const event = new Event('transitionend', { bubbles: true })
      Object.defineProperty(event, 'propertyName', { value: 'height' })
      act(() => { row.dispatchEvent(event) })
    },
  }
}

describe('Chat scroll collapse timing', () => {
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

  it('coalesces submitted inputs into one follow after the last row closes', () => {
    const h = mountScroll()
    h.startFold()
    h.update({ submissionId: 'first' })
    h.update({ submissionId: 'second' })
    expect(h.scrollTo).not.toHaveBeenCalled()
    expect(h.scroller.scrollTop).toBe(0)
    h.finishFold()
    expect(h.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: 'smooth' })
    expect(h.scroller.style.overflowAnchor).toBe('')
  })

  it('keeps excess collapse as bottom room without reversing the scrollport', async () => {
    const h = mountScroll()
    h.scroller.scrollTop = 600
    h.startFold()
    await act(async () => { await Promise.resolve() })
    h.grow(1_060)
    h.update({ submissionId: 'new-input' })
    h.grow(1_020)
    act(() => { vi.advanceTimersByTime(20) })
    expect(h.scroller.scrollTop).toBe(600)
    h.grow(980)
    act(() => { vi.advanceTimersByTime(20) })
    expect(h.scroller.scrollTop).toBe(600)
    fireEvent.scroll(h.scroller)
    expect(h.scroller.scrollTop).toBe(600)
    h.finishFold()
    expect(h.scroller.scrollTop).toBe(600)
    expect(h.scrollTo).not.toHaveBeenCalled()
    expect(h.scroller.querySelector<HTMLElement>('[data-chat-turn-spacer]')?.style.height).toBe('20px')
  })

  it('follows only the distance left after a smaller fold', async () => {
    const h = mountScroll()
    h.scroller.scrollTop = 600
    h.startFold()
    await act(async () => { await Promise.resolve() })
    h.grow(1_200)
    h.update({ submissionId: 'new-input' })
    h.grow(1_120)
    act(() => { vi.advanceTimersByTime(20) })
    expect(h.scroller.scrollTop).toBe(600)
    h.finishFold()
    expect(h.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 720, behavior: 'smooth' })
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
    h.finishFold()
    if (newInput) expect(h.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: 'smooth' })
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
