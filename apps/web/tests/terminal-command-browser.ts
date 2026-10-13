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
 * Select and copy text that wraps through the consumer's own stylesheet.
 * @param page - Browser page that owns the text.
 * @param command - One authored command line or the complete formatted arguments.
 * @param expected - Exact selectable text, including authored whitespace.
 * @param scrollport - Existing vertical scroll container around the text.
 * @returns Observed wrapping and native clipboard text for a semantic snapshot.
 */
export async function expectWrappedCommandText(
  page: Page, command: Locator, expected: string, scrollport: Locator,
): Promise<{ wrapped: boolean; text: string | null; copiedText: string }> {
  expect(await command.textContent()).toBe(expected)
  expect(await command.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre-wrap')
  await expectNoCommandTabStop(command)
  const wrapped = await command.evaluate((element, value) => {
    const text = element.firstChild
    if (!(text instanceof Text)) throw new Error('Command has no text node')
    const longest = value.split('\n').reduce((a, b) => a.length >= b.length ? a : b)
    const offset = value.indexOf(longest)
    const range = document.createRange()
    range.setStart(text, offset)
    range.setEnd(text, offset + longest.length)
    const rows = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => Math.round(rect.top))
    return new Set(rows).size > 1
  }, expected)
  expect(wrapped).toBe(true)
  expect(await scrollport.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const originalScrollTop = await scrollport.evaluate(element => element.scrollTop)
  const geometry = () => command.evaluate((element) => {
    const text = element.firstChild
    if (!(text instanceof Text) || text.length === 0) throw new Error('Command has no text node')
    const first = document.createRange()
    first.setStart(text, 0)
    first.setEnd(text, 1)
    const last = document.createRange()
    last.setStart(text, text.length - 1)
    last.setEnd(text, text.length)
    const head = first.getBoundingClientRect()
    const tail = last.getBoundingClientRect()
    return { head: { x: head.left, y: head.top + head.height / 2 }, tail: { x: tail.right, y: tail.top + tail.height / 2 } }
  })
  try {
    await scrollport.scrollIntoViewIfNeeded()
    await scrollport.evaluate((element) => { element.scrollTop = 0 })
    const start = await geometry()
    const viewport = await scrollport.boundingBox()
    if (viewport === null) throw new Error('Command scrollport is not visible')
    await page.mouse.move(start.head.x + 0.1, start.head.y)
    await page.mouse.down()
    try {
      if (start.tail.y > viewport.y + viewport.height) {
        await page.mouse.move(start.head.x + 0.1, viewport.y + viewport.height - 2)
        await page.mouse.wheel(0, await scrollport.evaluate(element => element.scrollHeight))
        await expect.poll(async () => (await geometry()).tail.y < viewport.y + viewport.height).toBe(true)
      }
      const end = await geometry()
      await page.mouse.move(end.tail.x - 0.1, end.tail.y, { steps: 5 })
    } finally {
      await page.mouse.up()
    }
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe(expected)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    const sentinel = `${expected}\nclipboard-before-copy`
    await page.evaluate(value => navigator.clipboard.writeText(value), sentinel)
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel)
    await page.keyboard.press('ControlOrMeta+C')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected)
    return { wrapped, text: await command.textContent(), copiedText: await page.evaluate(() => navigator.clipboard.readText()) }
  } finally {
    await scrollport.evaluate((element, top) => { element.scrollTop = top }, originalScrollTop)
    await command.evaluate(() => { document.getSelection()?.removeAllRanges() })
  }
}

/**
 * Verify a chat terminal wraps at a narrow width without changing its text.
 * @param page - Browser page that owns the card.
 * @param card - Chat terminal card with consumer-owned wrapping styles.
 * @param expected - Complete single authored command line.
 * @param width - Narrow card width that forces soft wrapping.
 * @returns Observed command wrapping and copied text in both themes.
 */
export async function expectWrappedTerminalCommand(page: Page, card: Locator, expected: string, width: number) {
  const originalWidth = await card.evaluate(element => element.style.width)
  const command = card.locator('[data-command-text]').first()
  const header = card.locator('[class*="_header_"]').first()
  const observations: ({ colorScheme: 'light' | 'dark' } & Awaited<ReturnType<typeof expectWrappedCommandText>>)[] = []
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
      await card.evaluate((element, value) => { element.style.width = `${value}px` }, width)
      observations.push({ colorScheme, ...await expectWrappedCommandText(page, command, expected, header) })
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await card.evaluate((element, value) => { element.style.width = value }, originalWidth)
      await expectNoCommandTabStop(command)
      expect(await command.textContent()).toBe(expected)
    }
    return observations
  } finally {
    await card.evaluate((element, value) => { element.style.width = value }, originalWidth)
    await page.emulateMedia({ colorScheme: null })
  }
}

/**
 * Verify a terminal's status dot remains visible beside the first visual command line.
 * @param card - Terminal card with its command banner scrolled to the start.
 * @param state - Expected running or settled state.
 * @returns Resolves after the dot fits inside the banner and aligns with the first line.
 */
export async function expectFirstLineTerminalState(card: Locator, state: 'ongoing' | 'done'): Promise<void> {
  const dot = card.locator('[class*="_runState_"][data-state]')
  await expect.poll(() => dot.getAttribute('data-state')).toBe(state)
  const geometry = await dot.evaluate((element) => {
    const prompt = element.closest('[class*="_promptLine_"]')
    const header = element.closest('[class*="_header_"]')
    if (prompt === null || header === null) throw new Error('Terminal status has no prompt banner')
    const bounds = element.getBoundingClientRect()
    const viewport = header.getBoundingClientRect()
    return {
      visible: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom
        && bounds.left >= viewport.left && bounds.right <= viewport.right,
      center: bounds.top + bounds.height / 2,
      firstLineCenter: prompt.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(prompt).lineHeight) / 2,
    }
  })
  expect(geometry.visible).toBe(true)
  expect(geometry.center).toBeCloseTo(geometry.firstLineCenter, 1)
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
