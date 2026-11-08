/** Zoomed automation pickers truncate wide labels and keep vertical choices reachable. */
import type { Browser, CDPSession, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-schedule'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { revealNavigationDrawer, saveFailureShot } from './support.ts'

const TITLE = 'Inspect zoomed automation pickers'
let scaffold: WebScaffold
let browser: Browser

beforeAll(async () => {
  scaffold = await launchWebScaffold()
  // Long zone labels use the same font on every host.
  await scaffold.ctx.settings.update('ui-theme', { textFontFamily: 'monospace' })
  await scaffold.ctx.schedule.create({
    title: TITLE, prompt: 'Inspect the deployment log',
    timing: { kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20990825T200800\nRRULE:FREQ=DAILY;COUNT=1' },
    target: { kind: 'new_once' },
  })
  browser = await chromium.launch()
})

afterAll(async () => {
  try {
    await browser?.close()
  } finally {
    await scaffold?.close()
  }
})

/** Pan the visual viewport to a row, then touch it without locator auto-scroll. */
async function touchRow(cdp: CDPSession, row: Locator): Promise<void> {
  const target = await row.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const view = window.visualViewport!
    return {
      left: Math.max(0, Math.min(window.innerWidth - view.width, rect.left + rect.width / 2 - view.width / 2)),
      top: Math.max(0, Math.min(window.innerHeight - view.height, rect.top + rect.height / 2 - view.height / 2)),
      offsetLeft: view.offsetLeft, offsetTop: view.offsetTop,
    }
  })
  await cdp.send('Input.synthesizeScrollGesture', {
    x: 1, y: 1, xDistance: target.offsetLeft - target.left, yDistance: target.offsetTop - target.top,
    gestureSourceType: 'mouse', speed: 800,
  })
  await expect.poll(() => row.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const view = window.visualViewport!
    const x = rect.left + rect.width / 2 - view.offsetLeft
    const y = rect.top + rect.height / 2 - view.offsetTop
    return x >= 0 && x < view.width && y >= 0 && y < view.height
  })).toBe(true)
  const point = await row.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return { x: rect.left + rect.width / 2 - window.visualViewport!.offsetLeft,
      y: rect.top + rect.height / 2 - window.visualViewport!.offsetTop }
  })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** Labels retain ellipsis styling without increasing the list's width. */
async function expectEllipsisStyle(labels: Locator): Promise<void> {
  expect(await labels.evaluateAll(nodes => nodes.every((node) => {
    const style = getComputedStyle(node)
    return style.textOverflow === 'ellipsis' && style.overflowX === 'hidden'
  }))).toBe(true)
}

describe.each([
  { locale: 'en-US', tasks: 'Automation tasks', time: 'Time', second: 'Second', zone: 'Time zone', repeat: 'Repeat' },
  { locale: 'zh-CN', tasks: '自动化任务', time: '时间', second: '秒', zone: '时区', repeat: '重复' },
])('automation pickers ($locale)', (copy) => {
  it('keeps the repeat menu inside the short layout viewport before and after zoom', async () => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 586 }, locale: copy.locale, timezoneId: 'Asia/Shanghai',
      isMobile: true, hasTouch: true,
    })
    const page = await context.newPage()
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await revealNavigationDrawer(page, copy.locale === 'zh-CN' ? 'zh' : 'en')
      await page.getByRole('button', { name: copy.tasks, exact: true }).click()
      const detail = page.getByTestId('task-manager-page')
      await detail.getByRole('button', { name: TITLE, exact: true }).click()
      await page.evaluate(() => document.fonts.ready)
      await detail.getByRole('button', { name: new RegExp(`^${copy.repeat}`) }).click()
      const menu = page.getByRole('menu')
      await expect.poll(() => menu.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return Math.min(rect.left, rect.top, innerWidth - rect.right, innerHeight - rect.bottom)
      })).toBeGreaterThanOrEqual(11.5)
      const unzoomed = await menu.boundingBox()
      expect(unzoomed).not.toBeNull()
      const cdp = await context.newCDPSession(page)
      try {
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 5 })
        await expect.poll(() => page.evaluate(() => visualViewport!.scale)).toBe(5)
        await expect.poll(() => menu.boundingBox()).toEqual(unzoomed)
      } finally {
        await cdp.detach()
      }
    } catch (error) {
      await saveFailureShot(page, `schedule-repeat-bounds-${copy.locale}`)
      throw error
    } finally {
      await context.close()
    }
  })

  it.each(['clock', 'zone'] as const)('keeps %s layout size, clipping and vertical choices reachable at 500% zoom', async (kind) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: copy.locale, timezoneId: 'Asia/Shanghai',
      isMobile: true, hasTouch: true,
    })
    const page: Page = await context.newPage()
    try {
      const consoleWatch = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await revealNavigationDrawer(page, copy.locale === 'zh-CN' ? 'zh' : 'en')
      await page.getByRole('button', { name: copy.tasks, exact: true }).click()
      const detail = page.getByTestId('task-manager-page')
      await detail.getByRole('button', { name: TITLE, exact: true }).click()
      await page.evaluate(() => document.fonts.ready)
      const trigger = kind === 'clock'
        ? detail.getByRole('button', { name: copy.time, exact: true })
        : detail.getByRole('button', { name: new RegExp(`^${copy.zone}`) })
      await trigger.click()
      const panel = kind === 'clock'
        ? page.getByRole('dialog', { name: copy.time, exact: true })
        : page.getByRole('menu')
      const before = await panel.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
      })
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 5 })
      await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(5)
      await expect.poll(() => panel.evaluate((node, original) => {
        const rect = node.getBoundingClientRect()
        return Math.max(Math.abs(rect.width - original.width), Math.abs(rect.height - original.height),
          Math.abs(rect.left - original.left), Math.abs(rect.top - original.top))
      }, before)).toBeLessThan(1)
      expect(await panel.evaluate(node => node.getBoundingClientRect().width > window.visualViewport!.width)).toBe(true)

      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      if (kind === 'clock') {
        await expectEllipsisStyle(panel.locator('[role="option"] > span'))
        const columns = panel.getByRole('listbox')
        expect(await columns.evaluateAll(nodes => nodes.every((node) => {
          const style = getComputedStyle(node)
          return style.overscrollBehaviorX === 'auto' && style.overscrollBehaviorY === 'contain'
        }))).toBe(true)
        expect(await columns.evaluateAll(nodes => nodes.every(node =>
          node.scrollWidth <= node.clientWidth))).toBe(true)
        const seconds = panel.getByRole('listbox', { name: copy.second, exact: true })
        expect(await seconds.evaluate((node) => {
          node.scrollTop = node.scrollHeight
          return node.scrollTop > 0
        })).toBe(true)
        const last = seconds.getByRole('option', { name: '59', exact: true })
        await expect.poll(() => last.evaluate((node) => {
          const label = node.firstElementChild!.getBoundingClientRect()
          const column = node.parentElement!.getBoundingClientRect()
          return label.left >= column.left && label.right <= column.right
            && label.top >= column.top && label.bottom <= column.bottom
        })).toBe(true)
        await touchRow(cdp, last)
        await expect.poll(() => trigger.textContent()).toMatch(/:59$/)
      } else {
        const labels = panel.locator('[role="menuitem"] > span')
        await expectEllipsisStyle(labels)
        // Long English names exercise overflow; translated labels may fit the layout-sized menu.
        if (copy.locale === 'en-US') {
          expect(await labels.evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth))).toBe(true)
        }
        const viewport = panel.locator('[role="presentation"]').last()
        expect(await viewport.evaluate((node) => {
          node.scrollTop = node.scrollHeight
          return node.scrollTop > 0 && node.scrollWidth <= node.clientWidth
        })).toBe(true)
        const last = panel.getByRole('menuitem').last()
        await expect.poll(() => last.evaluate((node) => {
          const row = node.getBoundingClientRect()
          const viewport = node.parentElement!.getBoundingClientRect()
          return row.left >= viewport.left && row.right <= viewport.right
            && row.top >= viewport.top && row.bottom <= viewport.bottom
        })).toBe(true)
        await touchRow(cdp, last)
        await panel.waitFor({ state: 'hidden' })
      }
      expect(consoleWatch.pageErrors).toEqual([])
      expect(consoleWatch.warnings).toEqual([])
      await cdp.detach()
    } catch (error) {
      await saveFailureShot(page, `schedule-picker-${copy.locale}-${kind}`)
      throw error
    } finally {
      await context.close()
    }
  })
})
