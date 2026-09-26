// @vitest-environment jsdom
/** Path labels retain their full hover text and update clipping with layout and file changes. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathLabel } from '../src/PathLabel.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PathLabel', () => {
  it.each([
    ['src/filename.ts', 'src/', 'filename.ts'],
    ['C:\\src\\filename.ts', 'C:\\src\\', 'filename.ts'],
    ['filename.ts', '', 'filename.ts'],
  ])('shows %s with a separate filename and full hover text', (path, directory, name) => {
    const view = render(<PathLabel path={path} data-testid="path" className="placement" />)
    const label = view.getByTestId('path')
    expect(label.textContent).toBe(path)
    expect(label.title).toBe(path)
    expect(label.classList.contains('placement')).toBe(true)
    expect(label.firstElementChild?.lastElementChild?.textContent).toBe(name)
    expect(label.firstElementChild?.children.length).toBe(directory === '' ? 1 : 2)
  })

  it('marks the path clipped while its text is wider than its box, re-reading on resize', () => {
    class FakeResizeObserver implements ResizeObserver {
      static latest: FakeResizeObserver | undefined
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
      constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.latest = this
      }

      fire(): void {
        this.callback([], this)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    let boxWidth = 300
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => boxWidth })
    try {
      const view = render(<PathLabel path="src/filename.ts" />)
      const path = view.container.querySelector<HTMLElement>('[data-path-label]')
      const text = path?.firstElementChild
      expect(path?.hasAttribute('data-path-clipped')).toBe(false)
      const observer = FakeResizeObserver.latest
      if (observer === undefined) throw new Error('expected the path to observe its size')
      expect(observer.observe).toHaveBeenCalledWith(path)
      expect(observer.observe).toHaveBeenCalledWith(text)

      boxWidth = 120
      act(() => { observer.fire() })
      expect(path?.hasAttribute('data-path-clipped')).toBe(true)

      boxWidth = 300
      act(() => { observer.fire() })
      expect(path?.hasAttribute('data-path-clipped')).toBe(false)
      view.unmount()
      expect(observer.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      for (const [name, descriptor] of [['offsetWidth', offsetWidth], ['clientWidth', clientWidth]] as const) {
        if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
        else Object.defineProperty(HTMLElement.prototype, name, descriptor)
      }
    }
  })

  it('rechecks clipping and hover text immediately when the selected path changes without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return (this.textContent?.length ?? 0) * 10
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    const view = render(<PathLabel path="a.ts" />)
    const label = view.container.querySelector<HTMLElement>('[data-path-label]')!
    expect(label.hasAttribute('data-path-clipped')).toBe(false)
    view.rerender(<PathLabel path="src/long-filename-before.ts" />)
    expect(label.hasAttribute('data-path-clipped')).toBe(true)
    expect(label.title).toBe('src/long-filename-before.ts')
    view.rerender(<PathLabel path="src/long-filename-after.ts" />)
    expect(label.textContent).toBe('src/long-filename-after.ts')
    view.rerender(<PathLabel path="b.ts" />)
    expect(label.hasAttribute('data-path-clipped')).toBe(false)
    expect(label.title).toBe('b.ts')
  })
})
