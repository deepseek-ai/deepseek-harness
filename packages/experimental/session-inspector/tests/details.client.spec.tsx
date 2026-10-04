// @vitest-environment jsdom
/** Raw-data height follows pointer capture and keyboard resizing without remounting the panel. */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { InspectorDetails } from '../src/client/views/InspectorDetails.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('drags the upper edge, retains height across record changes, and stops on cancellation', () => {
  const t = makeTranslate(en)
  const close = vi.fn()
  const ui = render(<InspectorDetails text="first record" close={close} t={t} />)
  const handle = ui.getByRole('separator')
  const panel = handle.parentElement!
  vi.spyOn(ui.container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500))
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 300, 500, 200))
  const captures = new Set<number>()
  Object.assign(handle, {
    setPointerCapture: (id: number) => { captures.add(id) },
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => { captures.delete(id) },
  })
  const pointer = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { pointerId: 1, button: 0, clientY: y })
    fireEvent(handle, event)
  }
  pointer('pointerdown', 300)
  pointer('pointermove', 250)
  expect(panel.style.flexBasis).toBe('50%')
  ui.rerender(<InspectorDetails text="second record" close={close} t={t} />)
  expect(handle.parentElement).toBe(panel)
  expect(panel.style.flexBasis).toBe('50%')
  pointer('pointercancel', 250)
  pointer('pointermove', 100)
  expect(panel.style.flexBasis).toBe('50%')
  expect(captures.size).toBe(0)
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  expect(panel.style.flexBasis).toBe('55%')
  fireEvent.keyDown(handle, { key: 'End' })
  expect(panel.style.flexBasis).toBe('80%')
  fireEvent.keyDown(handle, { key: 'Home' })
  expect(panel.style.flexBasis).toBe('15%')
  fireEvent.click(ui.getByRole('button', { name: 'Close' }))
  expect(close).toHaveBeenCalledOnce()
})

it('ignores competing pointers and missing geometry and releases capture on completion or loss', () => {
  const ui = render(<InspectorDetails text="record" close={vi.fn()} t={makeTranslate(en)} />)
  const handle = ui.getByRole('separator')
  const panel = handle.parentElement!
  const captured = new Set<number>()
  Object.assign(handle, {
    setPointerCapture: (id: number) => { captured.add(id) },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id) },
  })
  const pointer = (type: string, pointerId = 1, button = 0, y = 300): void => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { pointerId, button, clientY: y })
    fireEvent(handle, event)
  }
  pointer('pointerdown')
  expect(captured.size).toBe(0)
  vi.spyOn(ui.container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500))
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 300, 500, 200))
  pointer('pointerdown', 1, 1)
  expect(captured.size).toBe(0)
  pointer('pointerdown')
  pointer('pointerdown', 2)
  pointer('pointerup', 2, 0, 100)
  expect([...captured]).toEqual([1])
  expect(panel.style.flexBasis).toBe('40%')
  captured.clear()
  pointer('pointerup', 1, 0, 250)
  expect(panel.style.flexBasis).toBe('50%')
  pointer('pointercancel')
  pointer('pointerdown')
  pointer('lostpointercapture')
  pointer('pointermove', 1, 0, 100)
  expect(panel.style.flexBasis).toBe('50%')
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  expect(panel.style.flexBasis).toBe('45%')
  const ignored = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  fireEvent(handle, ignored)
  expect(ignored.defaultPrevented).toBe(false)
  handle.addEventListener('pointerdown', () => { panel.remove() }, { once: true })
  captured.clear()
  pointer('pointerdown')
  expect(captured.size).toBe(0)
  ui.container.append(panel)
})
