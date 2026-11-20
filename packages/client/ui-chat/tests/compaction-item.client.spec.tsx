// @vitest-environment jsdom

/**
 * The compaction marker's open request over time, driven by deferred openers:
 * one request at a time while busy, failures with retry, cancellation when the
 * row unmounts, changes seq, or loses its opener, and late settlements that
 * never write into the row that replaced them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import type { CompactionSummaryNode } from '../src/client/contract/snapshot.ts'
import { CompactionItem } from '../src/client/chat/CompactionItem.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(() => { cleanup() })

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)

function marker(seq: number): CompactionSummaryNode {
  return { kind: 'compaction', seq, summaryEventSeq: seq - 1, time: 1_000, shadowedItemCount: 2, shadowedTokenCount: 30 }
}

/** An opener whose every call stays pending until the test settles it. */
function deferredOpener() {
  const calls: { seq: number; signal: AbortSignal; settle: PromiseWithResolvers<string | null> }[] = []
  const open = vi.fn((seq: number, signal: AbortSignal) => {
    const settle = Promise.withResolvers<string | null>()
    calls.push({ seq, signal, settle })
    return settle.promise
  })
  return { open, calls }
}

function button(view: ReturnType<typeof render>): HTMLButtonElement {
  return view.container.querySelector<HTMLButtonElement>('button[data-compaction-seq]')!
}

describe('CompactionItem open requests', () => {
  it('disables a marker until the summary event enters the loaded history', () => {
    const opener = deferredOpener()
    const view = render(<CompactionItem t={t} node={{ ...marker(5), summaryEventSeq: null }} openCompaction={opener.open} />)
    expect(view.getByRole('button')).toHaveProperty('disabled', true)
    view.rerender(<CompactionItem t={t} node={marker(5)} openCompaction={opener.open} />)
    expect(view.getByRole('button')).toHaveProperty('disabled', false)
  })

  it('keeps one request in flight and stays busy until it settles', async () => {
    const opener = deferredOpener()
    const view = render(<CompactionItem t={t} node={marker(5)} openCompaction={opener.open} />)
    // Both clicks land before React commits the disabled state.
    act(() => { button(view).click(); button(view).click() })
    fireEvent.click(button(view))
    expect(opener.open).toHaveBeenCalledExactlyOnceWith(4, expect.any(AbortSignal))
    expect(button(view).disabled).toBe(true)
    expect(button(view).getAttribute('aria-busy')).toBe('true')
    await act(async () => { opener.calls[0]!.settle.resolve(null) })
    expect(button(view).disabled).toBe(false)
    expect(button(view).getAttribute('aria-busy')).toBe('false')
    expect(view.queryByRole('alert')).toBeNull()
    expect(opener.calls[0]!.signal.aborted).toBe(false)
  })

  it('shows a failure, clears it on retry, and accepts the retry result', async () => {
    const opener = deferredOpener()
    const view = render(<CompactionItem t={t} node={marker(5)} openCompaction={opener.open} />)
    fireEvent.click(button(view))
    await act(async () => { opener.calls[0]!.settle.resolve('Read failed') })
    expect(view.getByRole('alert').textContent).toBe('Read failed')
    expect(button(view).disabled).toBe(false)
    fireEvent.click(button(view))
    expect(view.queryByRole('alert')).toBeNull()
    await act(async () => { opener.calls[1]!.settle.reject(new Error('connection closed')) })
    expect(view.getByRole('alert').textContent).toBe('connection closed')
    fireEvent.click(button(view))
    await act(async () => { opener.calls[2]!.settle.reject('socket reset') })
    expect(view.getByRole('alert').textContent).toBe('socket reset')
    fireEvent.click(button(view))
    await act(async () => { opener.calls[3]!.settle.resolve(null) })
    expect(view.queryByRole('alert')).toBeNull()
    expect(opener.open).toHaveBeenCalledTimes(4)
  })

  it('cancels the pending request when the row unmounts', async () => {
    const opener = deferredOpener()
    const view = render(<CompactionItem t={t} node={marker(5)} openCompaction={opener.open} />)
    fireEvent.click(button(view))
    view.unmount()
    expect(opener.calls[0]!.signal.aborted).toBe(true)
    await act(async () => { opener.calls[0]!.settle.resolve('Read failed') })
  })

  it('cancels the pending request when the marker seq changes and ignores its late settlement', async () => {
    const opener = deferredOpener()
    const view = render(<CompactionItem t={t} node={marker(5)} openCompaction={opener.open} />)
    fireEvent.click(button(view))
    view.rerender(<CompactionItem t={t} node={marker(9)} openCompaction={opener.open} />)
    expect(opener.calls[0]!.signal.aborted).toBe(true)
    expect(button(view).disabled).toBe(false)
    expect(button(view).getAttribute('aria-busy')).toBe('false')
    fireEvent.click(button(view))
    expect(opener.calls[1]!.seq).toBe(8)
    await act(async () => { opener.calls[0]!.settle.resolve('Late failure') })
    expect(view.queryByRole('alert')).toBeNull()
    expect(button(view).getAttribute('aria-busy')).toBe('true')
    await act(async () => { opener.calls[1]!.settle.resolve(null) })
    expect(button(view).getAttribute('aria-busy')).toBe('false')
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('cancels the pending request when the opener is withdrawn and ignores its late settlement after a new opener arrives', async () => {
    const first = deferredOpener()
    const view = render(<CompactionItem t={t} node={marker(5)} openCompaction={first.open} />)
    fireEvent.click(button(view))
    view.rerender(<CompactionItem t={t} node={marker(5)} openCompaction={undefined} />)
    expect(first.calls[0]!.signal.aborted).toBe(true)
    expect(button(view).disabled).toBe(true)
    expect(button(view).getAttribute('aria-busy')).toBe('false')
    const second = deferredOpener()
    view.rerender(<CompactionItem t={t} node={marker(5)} openCompaction={second.open} />)
    expect(button(view).disabled).toBe(false)
    await act(async () => { first.calls[0]!.settle.reject(new Error('Late failure')) })
    expect(view.queryByRole('alert')).toBeNull()
    expect(button(view).disabled).toBe(false)
    fireEvent.click(button(view))
    expect(second.open).toHaveBeenCalledExactlyOnceWith(4, expect.any(AbortSignal))
    await act(async () => { second.calls[0]!.settle.resolve('Read failed') })
    expect(view.getByRole('alert').textContent).toBe('Read failed')
  })
})
