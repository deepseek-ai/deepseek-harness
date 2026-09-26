import { vi } from 'vitest'
import { act } from '@testing-library/react'

/**
 * Supply rail viewport sizes and element-local scrolling absent from jsdom.
 * @param initialHeight - first delivered height, or null to delay initial layout.
 * @returns a size-delivery control for the mounted rails.
 */
export function installTurnNavigatorObserver(initialHeight: number | null = 300) {
  const rails = new Map<Element, Observer>()
  let height = initialHeight

  class Observer implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(element: Element): void {
      if (!(element instanceof HTMLElement) || element.parentElement?.tagName !== 'NAV') return
      rails.set(element, this)
      element.scrollTo = (options: ScrollToOptions | number = {}, y?: number) => {
        const next = typeof options === 'number' ? y ?? 0 : options.top ?? element.scrollTop
        if (next === element.scrollTop) return
        element.scrollTop = next
        queueMicrotask(() => {
          if (element.isConnected) act(() => { element.dispatchEvent(new Event('scroll')) })
        })
      }
      queueMicrotask(() => {
        const currentHeight = height
        if (currentHeight !== null && rails.get(element) === this) act(() => { this.deliver(element, currentHeight) })
      })
    }

    unobserve(element: Element): void { rails.delete(element) }

    disconnect(): void {
      for (const [element, observer] of rails) {
        if (observer === this) rails.delete(element)
      }
    }

    deliver(target: Element, blockSize: number): void {
      const size = [{ inlineSize: 36, blockSize }]
      this.callback([{
        target,
        borderBoxSize: size,
        contentBoxSize: size,
        devicePixelContentBoxSize: size,
        contentRect: new DOMRectReadOnly(0, 0, 36, blockSize),
      }], this)
    }
  }

  vi.stubGlobal('ResizeObserver', Observer)
  return {
    resize(nextHeight: number): void {
      height = nextHeight
      for (const [element, observer] of rails) observer.deliver(element, height)
    },
  }
}
