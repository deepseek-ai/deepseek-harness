// @vitest-environment jsdom
/** Automatic focus presentation and subsequent keyboard navigation use the shipped theme sheet. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'

const base = readFileSync(resolve(import.meta.dirname, '../src/styles/base.css'), 'utf8')
const outline = '2px solid rgb(200, 100, 0)'

beforeEach(() => {
  const style = document.createElement('style')
  style.textContent = `button:focus { outline: ${outline}; border: 1px solid red; box-shadow: 0 0 4px black; }\n${base}`
  document.head.append(style)
})
afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren() })

function control(): HTMLButtonElement {
  const button = document.createElement('button')
  document.body.append(button)
  return button
}

it('omits automatic outlines through class updates while keeping borders and shadows', () => {
  const button = control()
  button.focus()
  const { border, boxShadow } = getComputedStyle(button)
  expect(getComputedStyle(button).outline).toBe(outline)
  focusWithoutRing(button)
  button.className = 'selected'
  expect(document.activeElement).toBe(button)
  expect(getComputedStyle(button).outline).toBe('none')
  expect(getComputedStyle(button).border).toBe(border)
  expect(getComputedStyle(button).boxShadow).toBe(boxShadow)
})

it('restores navigation outlines after repeated automatic focus without consuming input', () => {
  const button = control()
  for (const init of [{ key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'ArrowDown' }, { key: 'Home' }]) {
    focusWithoutRing(button)
    focusWithoutRing(button, { preventScroll: true })
    const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(getComputedStyle(button).outline).toBe(outline)
  }
})

it('keeps typing, modifier shortcuts and input-method navigation free of automatic outlines', () => {
  const button = control()
  focusWithoutRing(button)
  for (const init of [{ key: 'Enter' }, { key: 'a' }, { key: 'ArrowDown', isComposing: true },
    { key: 'ArrowDown', ctrlKey: true }, { key: 'ArrowDown', altKey: true }, { key: 'ArrowDown', metaKey: true }]) {
    button.dispatchEvent(new KeyboardEvent('keydown', init))
    expect(getComputedStyle(button).outline).toBe('none')
  }
  button.blur()
  button.focus()
  expect(getComputedStyle(button).outline).toBe(outline)
})

it('does not suppress later keyboard focus when an automatic target cannot receive focus', () => {
  const button = control()
  button.disabled = true
  focusWithoutRing(button)
  expect(document.activeElement).not.toBe(button)
  button.disabled = false
  button.focus()
  expect(getComputedStyle(button).outline).toBe(outline)
})
