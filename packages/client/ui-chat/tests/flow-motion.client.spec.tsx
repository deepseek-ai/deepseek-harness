// @vitest-environment jsdom
/** Chat row motion with instance-owned geometry and a controlled transition clock. */
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createFlowMotion, hiddenOrCollapsing, motionEnabled, useFlowHidden, useMotionHidden,
  type FlowMotion, type FlowMotionRows,
} from '../src/client/chat/flow-motion.ts'

const ownedRows = new Set<HTMLElement>()
const subscriptions = new Set<() => void>()
let motion: FlowMotion
let reserve: Mock<(px: number) => void>
let changed: Mock<(active: boolean) => void>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  reserve = vi.fn<(px: number) => void>()
  changed = vi.fn<(active: boolean) => void>()
  motion = createFlowMotion(reserve, changed)
})
afterEach(async () => {
  try {
    for (const unsubscribe of subscriptions) unsubscribe()
    subscriptions.clear()
    cleanup()
    for (const row of ownedRows) {
      motion.cancelMotion(row)
      row.remove()
    }
    ownedRows.clear()
    motion.clear()
    await Promise.resolve()
    expect(motion.foldActive()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

function rowWithHeight(height: number, parent: HTMLElement = document.body): HTMLElement {
  const row = document.createElement('div')
  Object.defineProperty(row, 'offsetHeight', { value: height, configurable: true })
  parent.append(row)
  ownedRows.add(row)
  return row
}

function transitionEnd(row: HTMLElement, propertyName: string): void {
  const event = new Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { value: propertyName })
  row.dispatchEvent(event)
}

function expectCleared(row: HTMLElement): void {
  expect(row.hasAttribute('data-chat-motion')).toBe(false)
  for (const property of ['height', 'marginTop', 'opacity', 'overflow', 'transition'] as const) {
    expect(row.style[property]).toBe('')
  }
}

interface HiddenRowProps {
  readonly motion: FlowMotionRows
  readonly hidden: boolean
  readonly onReveal: () => void
}

function PlainHiddenRow({ hidden, motion }: HiddenRowProps) {
  const ref = useRef<HTMLDivElement>(null)
  useMotionHidden(ref, hidden, motion)
  return <div ref={ref} data-testid="motion-row">Process details</div>
}

function UnboundHiddenRow({ motion }: { motion: FlowMotionRows }) {
  const ref = useRef<HTMLDivElement>(null)
  useMotionHidden(ref, true, motion)
  return null
}

function SearchableHiddenRow({ hidden, onReveal, motion }: HiddenRowProps) {
  const ref = useFlowHidden(hidden, onReveal, motion)
  return <div ref={ref} data-testid="motion-row">Process details</div>
}

describe('flow motion', () => {
  it('requires an enabled scope and respects reduced motion', () => {
    const scope = rowWithHeight(0)
    const row = rowWithHeight(80, scope)
    expect(motionEnabled(row)).toBe(false)
    scope.dataset.chatMotion = ''
    expect(motionEnabled(row)).toBe(true)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    expect(motionEnabled(row)).toBe(false)
  })

  it('finishes a zero-size collapse synchronously without a timer or reservation', async () => {
    const row = rowWithHeight(0)
    const done = vi.fn()
    motion.collapse(row, done)
    expect(done).toHaveBeenCalledTimes(1)
    expect(motion.foldActive()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await Promise.resolve()
    expect(reserve).not.toHaveBeenCalled()
    expectCleared(row)
  })

  it('commits hidden state before idle notification and finishes only on its own height transition', async () => {
    const row = rowWithHeight(80)
    const child = rowWithHeight(20, row)
    const done = vi.fn(() => { row.setAttribute('hidden', 'until-found') })
    const idle = vi.fn(() => { expect(row.getAttribute('hidden')).toBe('until-found') })
    motion.collapse(row, done)
    subscriptions.add(motion.onFoldIdle(idle))
    expect(motion.foldActive()).toBe(true)
    expect(hiddenOrCollapsing(row)).toBe(true)
    expect(row.hasAttribute('hidden')).toBe(false)
    expect(row.style.opacity).toBe('0')
    expect(row.style.height).toBe('0px')
    await Promise.resolve()
    expect(reserve).toHaveBeenCalledExactlyOnceWith(80)
    transitionEnd(row, 'opacity')
    transitionEnd(child, 'height')
    expect(done).not.toHaveBeenCalled()
    expect(idle).not.toHaveBeenCalled()
    transitionEnd(row, 'height')
    expect(done).toHaveBeenCalledTimes(1)
    expect(idle).toHaveBeenCalledTimes(1)
    expect(motion.foldActive()).toBe(false)
    expect(hiddenOrCollapsing(row)).toBe(true)
    expectCleared(row)
    transitionEnd(row, 'height')
    vi.runAllTimers()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('finishes a collapse when no transition event arrives', () => {
    const row = rowWithHeight(80)
    const done = vi.fn()
    motion.collapse(row, done)
    expect(done).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(done).toHaveBeenCalledTimes(1)
    expect(motion.foldActive()).toBe(false)
    expectCleared(row)
  })

  it('emits one active interval across overlapping folds and lets an idle waiter cancel', () => {
    const first = rowWithHeight(80)
    const second = rowWithHeight(90)
    const cancelled = vi.fn()
    const idle = vi.fn()
    motion.collapse(first, vi.fn())
    motion.collapse(second, vi.fn())
    const cancelWaiter = motion.onFoldIdle(cancelled)
    subscriptions.add(cancelWaiter)
    subscriptions.add(motion.onFoldIdle(idle))
    cancelWaiter()
    expect(changed).toHaveBeenCalledExactlyOnceWith(true)
    transitionEnd(first, 'height')
    expect(motion.foldActive()).toBe(true)
    expect(idle).not.toHaveBeenCalled()
    transitionEnd(second, 'height')
    expect(changed.mock.calls).toEqual([[true], [false]])
    expect(idle).toHaveBeenCalledTimes(1)
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('runs an idle callback immediately without retaining a second invocation', () => {
    const idle = vi.fn()
    const cancel = motion.onFoldIdle(idle)
    cancel()
    expect(idle).toHaveBeenCalledTimes(1)
    const row = rowWithHeight(80)
    motion.collapse(row, vi.fn())
    motion.cancelMotion(row)
    expect(idle).toHaveBeenCalledTimes(1)
  })

  it('cancels before reserve delivery without hiding the row or retaining callbacks', async () => {
    const row = rowWithHeight(80)
    const done = vi.fn()
    motion.collapse(row, done)
    motion.cancelMotion(row)
    motion.cancelMotion(row)
    expect(motion.foldActive()).toBe(false)
    expect(hiddenOrCollapsing(row)).toBe(false)
    expectCleared(row)
    await Promise.resolve()
    expect(reserve).not.toHaveBeenCalled()
    transitionEnd(row, 'height')
    vi.runAllTimers()
    expect(done).not.toHaveBeenCalled()
    expect(row.hasAttribute('hidden')).toBe(false)
  })

  it('reserves nested closing content once and subtracts newly revealed height', async () => {
    const parent = rowWithHeight(180)
    const child = rowWithHeight(80, parent)
    const sibling = rowWithHeight(50)
    const opening = rowWithHeight(30)
    motion.collapse(child, vi.fn())
    motion.collapse(parent, vi.fn())
    motion.collapse(sibling, vi.fn())
    motion.reveal(opening)
    await Promise.resolve()
    expect(reserve).toHaveBeenCalledExactlyOnceWith(200)
  })

  it('clears pending reservations and idle work with its owner', async () => {
    const row = rowWithHeight(80)
    const idle = vi.fn()
    motion.collapse(row, vi.fn())
    motion.onFoldIdle(idle)
    motion.clear()
    await Promise.resolve()
    expect(reserve).not.toHaveBeenCalled()
    expect(idle).not.toHaveBeenCalled()
    expectCleared(row)
  })

  it.each(['transition', 'timeout', 'cancel'] as const)('clears reveal styles and detaches completion on %s', (finish) => {
    const row = rowWithHeight(80)
    motion.reveal(row)
    expect(row.dataset.chatMotion).toBe('reveal')
    expect(motion.foldActive()).toBe(false)
    if (finish === 'transition') transitionEnd(row, 'height')
    else if (finish === 'timeout') vi.runAllTimers()
    else motion.cancelMotion(row)
    expectCleared(row)
    expect(vi.getTimerCount()).toBe(0)
    row.style.height = '120px'
    transitionEnd(row, 'height')
    vi.runAllTimers()
    expect(row.style.height).toBe('120px')
  })

  it('keeps a reveal active through opacity and descendant height transitions', () => {
    const row = rowWithHeight(80)
    const child = rowWithHeight(20, row)
    motion.reveal(row)
    transitionEnd(row, 'opacity')
    transitionEnd(child, 'height')
    expect(row.dataset.chatMotion).toBe('reveal')
    expect(vi.getTimerCount()).toBe(1)
    transitionEnd(row, 'height')
    expectCleared(row)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a zero-height reveal unchanged', () => {
    const row = rowWithHeight(0)
    motion.reveal(row)
    expectCleared(row)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves an unbound visibility ref idle through unmount', () => {
    const view = render(<UnboundHiddenRow motion={motion} />)
    expect(motion.foldActive()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    view.unmount()
    expect(motion.foldActive()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the original close clock when the reveal callback changes', async () => {
    const view = render(<div data-chat-motion=""><SearchableHiddenRow motion={motion} hidden={false} onReveal={vi.fn()} /></div>)
    const row = view.getByTestId('motion-row')
    Object.defineProperty(row, 'offsetHeight', { value: 80 })
    view.rerender(<div data-chat-motion=""><SearchableHiddenRow motion={motion} hidden onReveal={vi.fn()} /></div>)
    await Promise.resolve()
    act(() => { vi.advanceTimersByTime(100) })
    view.rerender(<div data-chat-motion=""><SearchableHiddenRow motion={motion} hidden onReveal={vi.fn()} /></div>)
    expect(changed.mock.calls).toEqual([[true]])
    expect(reserve).toHaveBeenCalledExactlyOnceWith(80)
    act(() => { vi.advanceTimersByTime(140) })
    expect(row.getAttribute('hidden')).toBe('until-found')
    expect(changed.mock.calls).toEqual([[true], [false]])
    expectCleared(row)
    expect(view.getByTestId('motion-row')).toBe(row)
  })

  it('retains initially hidden content through StrictMode effect replay without starting motion', () => {
    const view = render(<StrictMode><div data-chat-motion=""><PlainHiddenRow motion={motion} hidden onReveal={vi.fn()} /></div></StrictMode>)
    const row = view.getByTestId('motion-row')
    expect(row.getAttribute('hidden')).toBe('')
    expectCleared(row)
    expect(changed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe.each([
  { name: 'plain hidden', Component: PlainHiddenRow, hiddenValue: '' },
  { name: 'searchable hidden', Component: SearchableHiddenRow, hiddenValue: 'until-found' },
])('$name lifecycle', ({ Component, hiddenValue }) => {
  it('applies initial visibility without animating', () => {
    const view = render(<div data-chat-motion=""><Component motion={motion} hidden onReveal={vi.fn()} /></div>)
    const row = view.getByTestId('motion-row')
    expect(row.getAttribute('hidden')).toBe(hiddenValue)
    expectCleared(row)
    expect(motion.foldActive()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('hides immediately without motion when reduced motion is %s', (reduced) => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })))
    const onReveal = vi.fn()
    const view = render(<div data-chat-motion={reduced ? '' : undefined}><Component motion={motion} hidden={false} onReveal={onReveal} /></div>)
    const row = view.getByTestId('motion-row')
    Object.defineProperty(row, 'offsetHeight', { value: 80 })
    view.rerender(<div data-chat-motion={reduced ? '' : undefined}><Component motion={motion} hidden onReveal={onReveal} /></div>)
    expect(row.getAttribute('hidden')).toBe(hiddenValue)
    expectCleared(row)
    expect(motion.foldActive()).toBe(false)
  })

  it('cancels an unfinished collapse on unmount without delivering its hidden state', async () => {
    const onReveal = vi.fn()
    const view = render(<div data-chat-motion=""><Component motion={motion} hidden={false} onReveal={onReveal} /></div>)
    const row = view.getByTestId('motion-row')
    Object.defineProperty(row, 'offsetHeight', { value: 80 })
    view.rerender(<div data-chat-motion=""><Component motion={motion} hidden onReveal={onReveal} /></div>)
    expect(motion.foldActive()).toBe(true)
    view.unmount()
    expect(motion.foldActive()).toBe(false)
    expectCleared(row)
    await Promise.resolve()
    expect(reserve).not.toHaveBeenCalled()
    act(() => { vi.runAllTimers() })
    transitionEnd(row, 'height')
    expect(row.hasAttribute('hidden')).toBe(false)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('cancels a stale hide when the same row becomes visible again', () => {
    const onReveal = vi.fn()
    const view = render(<div data-chat-motion=""><Component motion={motion} hidden={false} onReveal={onReveal} /></div>)
    const row = view.getByTestId('motion-row')
    Object.defineProperty(row, 'offsetHeight', { value: 80 })
    view.rerender(<div data-chat-motion=""><Component motion={motion} hidden onReveal={onReveal} /></div>)
    expect(motion.foldActive()).toBe(true)
    view.rerender(<div data-chat-motion=""><Component motion={motion} hidden={false} onReveal={onReveal} /></div>)
    expect(motion.foldActive()).toBe(false)
    act(() => { vi.runAllTimers() })
    transitionEnd(row, 'height')
    expect(row.hasAttribute('hidden')).toBe(false)
    expectCleared(row)
    expect(view.getByTestId('motion-row')).toBe(row)
  })
})
