// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Toast } from '../src/Toast.tsx'

afterEach(cleanup)

describe('Toast', () => {
  it('announces its text and reports done after the hold-and-fade lifetime', () => {
    vi.useFakeTimers()
    try {
      const onDone = vi.fn()
      const view = render(<Toast text="最多添加 50 张图片" icon={<svg data-testid="icon" />} onDone={onDone} />)
      const banner = view.getByRole('alert')
      expect(banner.textContent).toContain('最多添加 50 张图片')
      expect(view.getByTestId('icon')).toBeTruthy()
      vi.advanceTimersByTime(3999)
      expect(onDone).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onDone).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds for the owner\'s window and hands the stylesheet the same value', () => {
    vi.useFakeTimers()
    try {
      const onDone = vi.fn()
      const view = render(<Toast text="切换失败" holdMs={6000} onDone={onDone} />)
      // One value drives both, so a banner can never unmount mid-fade: the
      // timer waits the hold plus the fade, and the stylesheet delays the
      // fade by the same hold.
      expect(view.getByRole('alert').style.getPropertyValue('--dsh-toast-hold')).toBe('6000ms')
      vi.advanceTimersByTime(6999)
      expect(onDone).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onDone).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps its original expiry across rerenders and calls the latest completion handler', () => {
    vi.useFakeTimers()
    try {
      const first = vi.fn()
      const latest = vi.fn()
      const view = render(<Toast text="archived" onDone={first} />)
      vi.advanceTimersByTime(1000)
      view.rerender(<Toast text="archived" onDone={latest} />)
      vi.advanceTimersByTime(2999)
      expect(first).not.toHaveBeenCalled()
      expect(latest).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(first).not.toHaveBeenCalled()
      expect(latest).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('centers over its anchor and re-measures on window resize', () => {
    vi.useFakeTimers()
    try {
      const anchor = document.createElement('div')
      document.body.appendChild(anchor)
      anchor.getBoundingClientRect = () => ({ left: 100, width: 400 }) as DOMRect
      const view = render(<Toast text="anchored" anchor={anchor} onDone={vi.fn()} />)
      expect(view.getByRole('alert').style.left).toBe('300px')
      anchor.getBoundingClientRect = () => ({ left: 200, width: 400 }) as DOMRect
      fireEvent(window, new Event('resize'))
      expect(view.getByRole('alert').style.left).toBe('400px')
      anchor.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flows prefixed actions inline as one sentence and hands each press to the owner', () => {
    vi.useFakeTimers()
    try {
      const undo = vi.fn()
      const filter = vi.fn()
      const view = render(
        <Toast
          text="会话已归档，可"
          tone="success"
          actions={[
            { label: '撤销', onClick: undo },
            { prefix: '或', label: '筛选已归档会话', onClick: filter },
          ]}
          onDone={vi.fn()}
        />,
      )
      // The success tone brings the circled green check itself; no icon prop.
      const glyph = view.getByRole('alert').querySelector('[aria-hidden]')
      expect(glyph?.className).toContain('success')
      expect(glyph?.querySelector('svg')).toBeTruthy()
      expect(view.getByRole('alert').textContent).toBe('会话已归档，可撤销或筛选已归档会话')
      fireEvent.click(view.getByRole('button', { name: '撤销' }))
      expect(undo).toHaveBeenCalledTimes(1)
      fireEvent.click(view.getByRole('button', { name: '筛选已归档会话' }))
      expect(filter).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders without an icon and cancels its timer on unmount', () => {
    vi.useFakeTimers()
    try {
      const onDone = vi.fn()
      const view = render(<Toast text="plain" onDone={onDone} />)
      expect(view.getByRole('alert').querySelector('[aria-hidden]')).toBeNull()
      view.unmount()
      vi.advanceTimersByTime(10_000)
      expect(onDone).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
