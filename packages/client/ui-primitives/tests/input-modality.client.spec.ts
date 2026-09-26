// @vitest-environment jsdom
/** Keyboard navigation and pointer focus use distinct tooltip and ring policies. */
import { afterEach, describe, expect, it } from 'vitest'
import { INPUT_MODALITY, INPUT_MODALITY_ATTRIBUTE, pointerModality } from '../src/input-modality.ts'

const press = (key: string, init: KeyboardEventInit = {}): void => {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, ...init }))
}
const click = (): void => { window.dispatchEvent(new Event('pointerdown')) }
const published = (): string | null => document.documentElement.getAttribute(INPUT_MODALITY_ATTRIBUTE)
const button = (): HTMLButtonElement => {
  const element = document.createElement('button')
  document.body.append(element)
  return element
}

afterEach(() => {
  document.body.replaceChildren()
  press('Tab')
  document.documentElement.removeAttribute(INPUT_MODALITY_ATTRIBUTE)
})

describe('input modality', () => {
  it('returns tooltips to the keyboard on any key', () => {
    for (const key of ['Shift', 'Escape', 'a', 'Enter', 'Tab']) {
      click()
      expect(pointerModality()).toBe(true)
      press(key)
      expect(pointerModality()).toBe(false)
    }
  })

  it('keeps a pointer focused control silent through keys that do not navigate', () => {
    click()
    for (const key of ['Shift', 'Escape', 'a', 'Control', 'Meta', 'Enter', ' ']) press(key)
    expect(published()).toBe(INPUT_MODALITY.pointer)
  })

  it('returns the ring to the keyboard on focus-navigation keys', () => {
    for (const key of ['Tab', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowDown', 'ArrowLeft']) {
      click()
      press(key)
      expect(published()).toBe(INPUT_MODALITY.keyboard)
    }
  })

  it.each(['Enter', ' ', 'Escape'])('returns the ring when %s moves focus to another control', (key) => {
    const anchor = button()
    const destination = button()
    click()
    anchor.focus()
    press(key)
    expect(published()).toBe(INPUT_MODALITY.pointer)
    destination.focus()
    expect(document.activeElement).toBe(destination)
    expect(published()).toBe(INPUT_MODALITY.keyboard)
  })

  it('keeps keyboard modality when a navigation key moves focus', () => {
    click()
    button().focus()
    press('Tab')
    button().focus()
    expect(published()).toBe(INPUT_MODALITY.keyboard)
  })

  it('keeps pointer focus silent when no key precedes the focus change', () => {
    click()
    button().focus()
    expect(published()).toBe(INPUT_MODALITY.pointer)
  })

  it('does not treat refocusing the same control after Shift as navigation', () => {
    const target = button()
    click()
    target.focus()
    press('Shift')
    target.blur()
    target.focus()
    expect(published()).toBe(INPUT_MODALITY.pointer)
  })

  it('does not carry a pending key across a window blur', () => {
    click()
    button().focus()
    press('Meta')
    window.dispatchEvent(new Event('blur'))
    button().focus()
    expect(published()).toBe(INPUT_MODALITY.pointer)
  })

  it('does not interpret input-method navigation as focus navigation', () => {
    click()
    press('ArrowDown', { isComposing: true })
    expect(published()).toBe(INPUT_MODALITY.pointer)
    button().focus()
    expect(published()).toBe(INPUT_MODALITY.pointer)
  })
})
