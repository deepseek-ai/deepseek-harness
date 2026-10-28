// @vitest-environment jsdom
/** The app-wide deletion toast: one outcome store behind one overlay banner. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createDeleteToastSource, ScheduleDeleteToast,
  type DeleteToastState, type ScheduleDeleteToastProps,
} from '../src/client/DeleteToast.tsx'
import { en, zh } from '../src/client/task-manager-locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

function mount(state: DeleteToastState | null, dictionary: typeof en | typeof zh = en) {
  const dismiss = vi.fn()
  const props = {
    useToast: <T,>(select: (value: DeleteToastState | null) => T): T => select(state),
    dismiss,
    t: makeTranslate(dictionary),
  } as ScheduleDeleteToastProps
  return { view: render(<ScheduleDeleteToast {...props} />), dismiss }
}

describe('delete toast source', () => {
  it('publishes each settled outcome under a new sequence and ignores pending', () => {
    const source = createDeleteToastSource()
    const listener = vi.fn()
    const stop = source.hooks.toast.subscribe(listener)
    expect(source.hooks.toast.getSnapshot()).toBeNull()

    // A pending outcome raises nothing: the deletion already in flight reports its own.
    source.report('pending')
    expect(listener).not.toHaveBeenCalled()
    expect(source.hooks.toast.getSnapshot()).toBeNull()

    source.report('deleted')
    expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'deleted', seq: 1 })
    source.report('failed')
    expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'deleteFailed', seq: 2 })
    // The next outcome advances the sequence, so a re-shown banner restarts.
    source.report('deleted')
    expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'deleted', seq: 3 })
    source.dismiss()
    expect(source.hooks.toast.getSnapshot()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(4)

    stop()
    source.report('deleted')
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('publishes each settled bulk removal with its count or failure', () => {
    const source = createDeleteToastSource()
    source.reportClear({ cleared: true, count: 3 })
    expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'cleared', count: 3, seq: 1 })
    // A removal that found nothing keeps its own zero, so the banner can say so.
    source.reportClear({ cleared: true, count: 0 })
    expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'cleared', count: 0, seq: 2 })
    source.reportClear({ cleared: false })
    expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'clearFailed', seq: 3 })
  })
})

describe('ScheduleDeleteToast', () => {
  it('renders nothing while no outcome shows', () => {
    mount(null)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the success banner for a confirmed deletion and dismisses once done', () => {
    vi.useFakeTimers()
    const { dismiss } = mount({ kind: 'deleted', seq: 1 })
    expect(screen.getByRole('alert').textContent).toBe(en['toast.deleted'])
    act(() => { vi.runAllTimers() })
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('shows the warning banner for a deletion that could not be confirmed', () => {
    mount({ kind: 'deleteFailed', seq: 2 }, zh)
    expect(screen.getByRole('alert').textContent).toBe(zh['toast.deleteFailed'])
  })

  it('states how many inactive tasks a bulk removal cleared, singular for one', () => {
    vi.useFakeTimers()
    const many = mount({ kind: 'cleared', count: 4, seq: 3 })
    expect(screen.getByRole('alert').textContent).toBe(en['toast.cleared.other'].replace('{count}', '4'))
    act(() => { vi.runAllTimers() })
    expect(many.dismiss).toHaveBeenCalledOnce()
    cleanup()
    mount({ kind: 'cleared', count: 1, seq: 4 })
    expect(screen.getByRole('alert').textContent).toBe(en['toast.cleared.one'].replace('{count}', '1'))
  })

  it('states that a bulk removal found nothing instead of a zero count', () => {
    mount({ kind: 'cleared', count: 0, seq: 4 }, zh)
    expect(screen.getByRole('alert').textContent).toBe(zh['toast.clearedNone'])
  })

  it('shows the warning banner for a bulk removal that failed', () => {
    mount({ kind: 'clearFailed', seq: 5 }, zh)
    expect(screen.getByRole('alert').textContent).toBe(zh['toast.clearFailed'])
  })
})
