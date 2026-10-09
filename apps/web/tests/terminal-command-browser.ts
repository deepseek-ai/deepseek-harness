import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'

/**
 * Scroll and select an overflowing command in its rendered terminal card.
 * @param page - Browser page that owns the card.
 * @param card - Terminal card rendered by the application.
 * @param expected - Complete single-line command.
 * @param width - Narrow card width that leaves part of the command offscreen.
 * @param label - Localized accessible name for the command line.
 * @returns Resolves when the tail is reachable and native copying retains the full command.
 */
export async function expectSelectableTerminalCommand(page: Page, card: Locator, expected: string, width: number, label = 'Command line 1'): Promise<void> {
  const originalWidth = await card.evaluate(element => element.style.width)
  const command = card.locator('[data-command-text]').first()
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
      expect(await command.textContent()).toBe(expected)
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await command.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        return range.getClientRects().length
      })).toBe(1)
      await card.evaluate((element, value) => { element.style.width = `${value}px` }, width)
      await command.scrollIntoViewIfNeeded()
      const controls = card.locator('[class*="_cwd"], [class*="_runState"]:not([class*="Label"]), [class*="_status"], [class*="_copyButton"]')
      expect(await controls.count()).toBeGreaterThanOrEqual(3)
      const before = await controls.evaluateAll(elements => elements.map((element) => {
        const { x, y, width: w, height } = element.getBoundingClientRect()
        return { x, y, width: w, height }
      }))
      await expectSelectableCommandText(page, command, expected, label)
      expect(await controls.evaluateAll(elements => elements.map((element) => {
        const { x, y, width: w, height } = element.getBoundingClientRect()
        return { x, y, width: w, height }
      }))).toEqual(before)
      const originalWhitespace = await card.evaluate((element) => {
        const property = '--dsl-terminal-command-whitespace'
        const previous = { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) }
        element.style.setProperty(property, 'pre-wrap')
        return previous
      })
      try {
        await expectNoCommandTabStop(command)
        expect(await command.evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          return range.getClientRects().length
        })).toBeGreaterThan(1)
      } finally {
        await card.evaluate((element, previous) => {
          element.style.setProperty('--dsl-terminal-command-whitespace', previous.value, previous.priority)
        }, originalWhitespace)
      }
      await expectCommandFocusAfterResize(card, command)
      await card.evaluate((element, value) => { element.style.width = value }, originalWidth)
    }
  } finally {
    await card.evaluate((element, value) => { element.style.width = value }, originalWidth)
    await page.emulateMedia({ colorScheme: null })
  }
}

/**
 * Verify a resized command drops its explicit keyboard stop when all text fits.
 * @param container - Width owner of the command.
 * @param command - Mounted command text.
 * @returns Resolves after widening removes the overflow-only accessibility attributes.
 */
export async function expectCommandFocusAfterResize(container: Locator, command: Locator): Promise<void> {
  const originalWidth = await container.evaluate(element => element.style.width)
  const extra = await command.evaluate(element => element.scrollWidth - element.clientWidth)
  const width = await container.evaluate(element => element.getBoundingClientRect().width)
  try {
    await container.evaluate((element, value) => { element.style.width = `${value}px` }, width + Math.max(extra, 0) + 20)
    await expectNoCommandTabStop(command)
  } finally {
    await container.evaluate((element, value) => { element.style.width = value }, originalWidth)
  }
}

async function expectNoCommandTabStop(command: Locator): Promise<void> {
  await expect.poll(() => command.evaluate(element => ({
    overflow: element.scrollWidth > element.clientWidth + 1,
    tabIndex: element.getAttribute('tabindex'),
    role: element.getAttribute('role'),
    label: element.getAttribute('aria-label'),
  }))).toEqual({ overflow: false, tabIndex: null, role: null, label: null })
}

/**
 * Verify native command selection within a text scrollport.
 * @param page - Browser page that owns the text.
 * @param command - Text scrollport containing the command, optionally within argument JSON.
 * @param expected - Complete command, including its offscreen suffix.
 * @param label - Localized accessible name for the overflowing text.
 * @returns Resolves after horizontal navigation and native selection/copy succeed.
 */
export async function expectSelectableCommandText(page: Page, command: Locator, expected: string, label: string): Promise<void> {
  const geometry = async () => command.evaluate((element, value) => {
    const text = element.firstChild
    if (!(text instanceof Text) || text.length === 0) throw new Error('Command has no text node')
    const offset = text.data.indexOf(value)
    if (offset < 0) throw new Error('Command text does not contain the expected command')
    const first = document.createRange()
    first.setStart(text, offset)
    first.setEnd(text, offset + 1)
    const last = document.createRange()
    last.setStart(text, offset + value.length - 1)
    last.setEnd(text, offset + value.length)
    const head = first.getBoundingClientRect()
    const tail = last.getBoundingClientRect()
    const viewport = element.getBoundingClientRect()
    return {
      head: { x: head.left, y: head.top, height: head.height },
      tail: { x: tail.right, y: tail.top },
      left: viewport.left,
      right: viewport.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
    }
  }, expected)
  expect(await command.textContent()).toContain(expected)
  const start = await geometry()
  expect(start.scrollWidth).toBeGreaterThan(start.clientWidth)
  expect(start.tail.y).toBeCloseTo(start.head.y, 1)
  expect(start.tail.x).toBeGreaterThan(start.right)
  try {
    await expect.poll(() => command.evaluate(element => ({
      tabIndex: element.getAttribute('tabindex'),
      role: element.getAttribute('role'),
      label: element.getAttribute('aria-label'),
    }))).toEqual({ tabIndex: '0', role: 'group', label })
    await command.focus()
    await page.keyboard.press('Shift+Tab')
    expect(await command.evaluate(element => document.activeElement === element)).toBe(false)
    await page.keyboard.press('Tab')
    expect(await command.evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => command.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => command.evaluate(element => element.scrollLeft)).toBe(0)
    await command.hover()
    await page.mouse.wheel(start.scrollWidth, 0)
    await expect.poll(async () => {
      const end = await geometry()
      return end.tail.x <= end.right + 1 && end.tail.x >= end.left && end.scrollLeft > 0
    }).toBe(true)
    await page.mouse.wheel(-start.scrollWidth, 0)
    await expect.poll(() => command.evaluate(element => element.scrollLeft)).toBe(0)
    const head = await geometry()
    await page.mouse.move(head.head.x + 0.1, head.head.y + head.head.height / 2)
    await page.mouse.down()
    try {
      await page.mouse.move(head.right - 1, head.head.y + head.head.height / 2, { steps: 5 })
      await page.mouse.wheel(start.scrollWidth, 0)
      await expect.poll(async () => {
        const value = await geometry()
        return value.tail.x <= head.right + 1 ? 'visible' : JSON.stringify({ before: head, after: value })
      }).toBe('visible')
      const end = await geometry()
      await page.mouse.move(end.tail.x - 0.1, head.head.y + head.head.height / 2)
    } finally {
      await page.mouse.up()
    }
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe(expected)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.keyboard.press('ControlOrMeta+C')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected)
  } finally {
    await command.evaluate((element) => {
      element.scrollLeft = 0
      element.blur()
      document.getSelection()?.removeAllRanges()
    })
  }
}
