// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClipboardCopy } from '../src/use-clipboard-copy.ts'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const writeText = vi.fn<(text: string) => Promise<void>>()
beforeEach(() => {
  vi.useFakeTimers()
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (originalClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', originalClipboard)
})

/** Complete the clipboard promise and its success feedback callback. */
async function settleCopy(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('useClipboardCopy', () => {
  it('copies current text, blocks success-window repeats, and resets after one second', async () => {
    const { result, rerender } = renderHook(({ text }) => useClipboardCopy(text), {
      initialProps: { text: 'first' }, wrapper: StrictMode,
    })
    const callback = result.current.onCopy
    rerender({ text: 'first' })
    expect(result.current.onCopy).toBe(callback)
    act(() => { result.current.onCopy() })
    expect(writeText).toHaveBeenCalledWith('first')
    await settleCopy()
    expect(result.current.copied).toBe(true)
    act(() => { result.current.onCopy() })
    expect(writeText).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current.copied).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    rerender({ text: 'second' })
    act(() => { result.current.onCopy() })
    expect(writeText).toHaveBeenLastCalledWith('second')
    await settleCopy()
  })

  it('blocks overlapping writes and ignores completion after unmount', async () => {
    let finish: (() => void) | undefined
    writeText.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const { result, unmount } = renderHook(() => useClipboardCopy('pending'))
    act(() => { result.current.onCopy(); result.current.onCopy() })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(result.current.copied).toBe(false)
    unmount()
    finish!()
    await settleCopy()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps failure unconfirmed and allows another attempt', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const { result } = renderHook(() => useClipboardCopy('retry'))
    act(() => { result.current.onCopy() })
    await settleCopy()
    expect(result.current.copied).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { result.current.onCopy() })
    await settleCopy()
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(result.current.copied).toBe(true)
  })

  it('releases its success reset timer on unmount', async () => {
    const { result, unmount } = renderHook(() => useClipboardCopy('done'))
    act(() => { result.current.onCopy() })
    await settleCopy()
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
