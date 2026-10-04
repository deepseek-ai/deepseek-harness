// @vitest-environment jsdom
/** Inspector iframe keyboard listeners follow document loads and the effective command binding. */
import { afterEach, expect, it, vi } from 'vitest'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { bindInspectorKeyboard } from '../src/client/bottom/keyboard.ts'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

function key(options: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { code: 'F12', key: 'F12', shiftKey: true, bubbles: true, cancelable: true, ...options })
}

it('replaces document listeners on load and removes them on disposal or cross-origin navigation', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const first = frame.contentDocument!
  const second = document.implementation.createHTMLDocument()
  const delivered = vi.fn((event: KeyboardEvent) => { event.preventDefault() })
  frame.addEventListener('keydown', delivered)
  const off = bindInspectorKeyboard(frame, () => ({ code: 'F12', modifiers: ['shift'] }))
  const original = key()
  first.dispatchEvent(original)
  expect(original.defaultPrevented).toBe(true)
  const content = vi.spyOn(frame, 'contentDocument', 'get').mockReturnValue(second)
  frame.dispatchEvent(new Event('load'))
  first.dispatchEvent(key())
  expect(delivered).toHaveBeenCalledTimes(1)
  second.dispatchEvent(key())
  expect(delivered).toHaveBeenCalledTimes(2)
  content.mockReturnValue(null)
  frame.dispatchEvent(new Event('load'))
  second.dispatchEvent(key())
  expect(delivered).toHaveBeenCalledTimes(2)
  content.mockReturnValue(first)
  frame.dispatchEvent(new Event('load'))
  off()
  first.dispatchEvent(key())
  frame.dispatchEvent(new Event('load'))
  first.dispatchEvent(key())
  expect(delivered).toHaveBeenCalledTimes(2)
})

it('leaves composing, consumed, unbound, and nonmatching keys inside DevTools', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const target = frame.contentDocument!
  let binding: ShortcutCatalogEntry['binding'] | undefined
  const delivered = vi.fn()
  frame.addEventListener('keydown', delivered)
  const off = bindInspectorKeyboard(frame, () => binding)
  try {
    target.dispatchEvent(key())
    binding = null
    target.dispatchEvent(key())
    binding = { code: 'F12', secondCode: 'KeyA', modifiers: ['shift'] }
    target.dispatchEvent(key())
    binding = { code: 'F12', modifiers: ['shift'] }
    target.dispatchEvent(key({ code: 'F11' }))
    target.dispatchEvent(key({ ctrlKey: true }))
    target.dispatchEvent(key({ isComposing: true }))
    const consumed = key()
    consumed.preventDefault()
    target.dispatchEvent(consumed)
    const altGraph = key()
    vi.spyOn(altGraph, 'getModifierState').mockImplementation(modifier => modifier === 'AltGraph')
    target.dispatchEvent(altGraph)
    expect(delivered).not.toHaveBeenCalled()
    const repeat = key({ repeat: true })
    target.dispatchEvent(repeat)
    expect(delivered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'F12', repeat: true }))
    expect(repeat.defaultPrevented).toBe(false)
  } finally { off() }
})
