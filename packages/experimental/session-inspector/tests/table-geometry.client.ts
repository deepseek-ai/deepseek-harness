/** Fixed row geometry for Inspector tests in jsdom, which has no layout engine. */

import { cleanup } from '@testing-library/react'
import { onTestFinished } from 'vitest'

/** @param height - Modeled scroll viewport height. */
export function installInspectorTableGeometry(height = 300): void {
  const restorations: (() => void)[] = []
  onTestFinished(() => { cleanup(); for (const restore of restorations.reverse()) restore() })
  const define = (target: object, key: string, descriptor: PropertyDescriptor): void => {
    const previous = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, ...descriptor })
    restorations.push(() => {
      if (previous === undefined) Reflect.deleteProperty(target, key)
      else Object.defineProperty(target, key, previous)
    })
  }
  const rowHeight = (row: Element): number => Number.parseFloat(row.querySelector('td')?.style.height || '30')
  define(HTMLElement.prototype, 'offsetHeight', { get: () => height })
  define(HTMLElement.prototype, 'offsetWidth', { get: () => 660 })
  define(Element.prototype, 'clientHeight', { get: () => height })
  define(Element.prototype, 'scrollHeight', { get(this: Element) {
    const table = this.querySelector('table')
    return table === null ? 0 : 30 + [...table.querySelectorAll('tbody tr')].reduce((total, row) => total + rowHeight(row), 0)
  } })
  define(Element.prototype, 'scrollTo', { value(this: Element, options: ScrollToOptions) {
    this.scrollTop = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight))
  } })
  // oxlint-disable-next-line typescript/unbound-method -- The override calls the saved method with the current element as this.
  const rect = Element.prototype.getBoundingClientRect
  define(Element.prototype, 'getBoundingClientRect', { value(this: Element): DOMRect {
    if (!(this instanceof HTMLTableRowElement) || this.parentElement?.tagName !== 'TBODY') return rect.call(this)
    const scroller = this.closest('table')!.parentElement!
    let top = 30 - scroller.scrollTop
    for (const row of this.parentElement.children) {
      if (row === this) break
      top += rowHeight(row)
    }
    if (this.style.top !== '') top = Math.max(top, Number.parseFloat(this.style.top))
    return new DOMRect(0, top, 660, rowHeight(this))
  } })
}
