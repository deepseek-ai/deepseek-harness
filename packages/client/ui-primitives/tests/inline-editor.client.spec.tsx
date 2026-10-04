// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InlineEditor } from '../src/InlineEditor.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderEditor(value = 'draft') {
  const handlers = { onChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn() }
  const view = render(<InlineEditor value={value} label="Edit" {...handlers} />)
  return { ...handlers, view, box: screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit' }) }
}

describe('InlineEditor', () => {
  it('focuses a one-row textarea that keeps line breaks', () => {
    const { box, onChange } = renderEditor('one\ntwo')
    expect(document.activeElement).toBe(box)
    expect(box.rows).toBe(1)
    expect(box.value).toBe('one\ntwo')
    fireEvent.change(box, { target: { value: 'one\ntwo\nthree' } })
    expect(onChange).toHaveBeenCalledWith('one\ntwo\nthree')
  })

  it('saves on plain Enter only, and cancels on Escape', () => {
    const { box, onSave, onCancel } = renderEditor()
    expect(fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })).toBe(true)
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(box, { key: 'a' })
    expect(onSave).not.toHaveBeenCalled()

    const enter = createEvent.keyDown(box, { key: 'Enter' })
    fireEvent(box, enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('sizes to its content plus border, and refits when its width changes', () => {
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
    let scrollHeight = 20
    const descriptors = (['scrollHeight', 'offsetHeight', 'clientHeight'] as const)
      .map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 27 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 26 })
    try {
      const { box, view } = renderEditor()
      expect(box.style.height).toBe('21px')
      const observer = FakeResizeObserver.latest
      if (observer === undefined) throw new Error('expected the editor to observe its size')
      expect(observer.observe).toHaveBeenCalledWith(box)

      scrollHeight = 60
      act(() => { observer.fire() })
      expect(box.style.height).toBe('61px')
      view.unmount()
      expect(observer.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
        else Object.defineProperty(HTMLElement.prototype, name, descriptor)
      }
    }
  })
})
