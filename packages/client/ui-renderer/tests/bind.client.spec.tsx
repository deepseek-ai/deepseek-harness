// @vitest-environment jsdom
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { bindSnapshotSelector } from '../src/client/bind.ts'
import type { HostObservable as ObservableSnapshot, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots/client'

// Keep equality local: this suite asserts the eq parameter contract without
// adding a reverse dependency from the UI renderer to runtime.
const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.is(a[k], b[k]))

interface Snap { a: number; b: number }

/** Hand-rolled observable source so subscription counting is exact. */
function makeSource(initial: Snap) {
  let state = initial
  const listeners = new Set<() => void>()
  let subscribeCalls = 0
  const source: ObservableSnapshot<Snap> = {
    getSnapshot: () => state,
    subscribe: (fn) => {
      subscribeCalls += 1
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
  return {
    source,
    set: (next: Snap) => {
      state = next
      for (const fn of [...listeners]) fn()
    },
    stats: { get subscribeCalls() { return subscribeCalls }, get active() { return listeners.size } },
  }
}

function Harness<S>({ useSelector, sel, eq, probe }: {
  useSelector: SnapshotSelectorHook<Snap>
  sel: (s: Snap) => S
  eq?: (a: S, b: S) => boolean
  probe: { renders: number; value?: S | undefined }
}) {
  probe.renders += 1
  probe.value = useSelector(sel, eq)
  return null
}

describe('bindSnapshotSelector', () => {
  it('re-renders on selected change and bails out when the slice is equal', () => {
    const { source, set } = makeSource({ a: 1, b: 10 })
    const useSelector = bindSnapshotSelector(source)
    const probe = { renders: 0, value: undefined as number | undefined }
    render(<Harness useSelector={useSelector} sel={s => s.a} probe={probe} />)
    expect(probe.value).toBe(1)
    const before = probe.renders
    act(() => { set({ a: 1, b: 11 }) })   // unrelated field: Object.is bail
    expect(probe.renders).toBe(before)
    act(() => { set({ a: 2, b: 11 }) })
    expect(probe.renders).toBe(before + 1)
    expect(probe.value).toBe(2)
  })

  it('supports custom equality for object slices', () => {
    const { source, set } = makeSource({ a: 1, b: 10 })
    const useSelector = bindSnapshotSelector(source)
    const probe = { renders: 0, value: undefined as { a: number } | undefined }
    render(<Harness useSelector={useSelector} sel={s => ({ a: s.a })} eq={shallowEqual} probe={probe} />)
    const before = probe.renders
    act(() => { set({ a: 1, b: 99 }) })   // fresh object, shallow-equal slice
    expect(probe.renders).toBe(before)
    act(() => { set({ a: 5, b: 99 }) })
    expect(probe.renders).toBe(before + 1)
    expect(probe.value).toEqual({ a: 5 })
  })

  it('does not resubscribe across re-renders of the same component', () => {
    const { source, set, stats } = makeSource({ a: 1, b: 10 })
    const useSelector = bindSnapshotSelector(source)
    const probe = { renders: 0, value: undefined as number | undefined }
    const { rerender } = render(<Harness useSelector={useSelector} sel={s => s.a} probe={probe} />)
    const after = stats.subscribeCalls
    rerender(<Harness useSelector={useSelector} sel={s => s.a} probe={probe} />)
    act(() => { set({ a: 2, b: 10 }) })
    rerender(<Harness useSelector={useSelector} sel={s => s.a} probe={probe} />)
    expect(stats.subscribeCalls).toBe(after)
  })

  it('is StrictMode-safe and cleans up subscriptions on unmount', () => {
    const { source, stats } = makeSource({ a: 1, b: 10 })
    const useSelector = bindSnapshotSelector(source)
    const probe = { renders: 0, value: undefined as number | undefined }
    const view = render(
      <StrictMode>
        <Harness useSelector={useSelector} sel={s => s.a} probe={probe} />
      </StrictMode>,
    )
    expect(probe.value).toBe(1)
    view.unmount()
    expect(stats.active).toBe(0)
  })

  it('binds method-style sources without losing this', () => {
    class MethodSource implements ObservableSnapshot<Snap> {
      private state: Snap = { a: 7, b: 0 }
      private listeners = new Set<() => void>()
      getSnapshot(): Snap { return this.state }
      subscribe(fn: () => void): () => void {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      }
    }
    const useSelector = bindSnapshotSelector(new MethodSource())
    const probe = { renders: 0, value: undefined as number | undefined }
    render(<Harness useSelector={useSelector} sel={s => s.a} probe={probe} />)
    expect(probe.value).toBe(7)
  })

  it('memoizes the selector result against getSnapshot spam', () => {
    const { source } = makeSource({ a: 1, b: 10 })
    const sel = vi.fn((s: Snap) => s.a)
    const useSelector = bindSnapshotSelector(source)
    const probe = { renders: 0, value: undefined as number | undefined }
    const { rerender } = render(<Harness useSelector={useSelector} sel={sel} probe={probe} />)
    const calls = sel.mock.calls.length
    rerender(<Harness useSelector={useSelector} sel={sel} probe={probe} />)
    // Same snapshot + same selector reference: no recompute beyond bookkeeping.
    expect(sel.mock.calls.length).toBeLessThanOrEqual(calls + 1)
  })
})
