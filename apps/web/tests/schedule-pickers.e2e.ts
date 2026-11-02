/** Zoomed automation pickers truncate wide labels and keep vertical choices reachable. */
import type { Browser, Locator, Page } from 'playwright'
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
  // Two digits must overflow at 500% zoom; narrower system UI fonts can fit.
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

/** Assert that the complete floating card stays inside the zoomed visual viewport. */
async function expectContained(panel: Locator): Promise<void> {
  await expect.poll(() => panel.evaluate((node) => {
    const view = window.visualViewport!
    const rect = node.getBoundingClientRect()
    return Math.min(rect.left - view.offsetLeft, rect.top - view.offsetTop,
      view.offsetLeft + view.width - rect.right, view.offsetTop + view.height - rect.bottom)
  })).toBeGreaterThanOrEqual(11.5)
}

/** Narrow labels ellipsize instead of increasing their row's width. */
async function expectEllipsizedText(labels: Locator): Promise<void> {
  expect(await labels.evaluateAll(nodes => nodes.every((node) => {
    const style = getComputedStyle(node)
    return style.textOverflow === 'ellipsis' && style.overflowX === 'hidden'
  }))).toBe(true)
  expect(await labels.evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth))).toBe(true)
}

describe.each([
  { locale: 'en-US', tasks: 'Automation tasks', time: 'Time', second: 'Second', zone: 'Time zone' },
  { locale: 'zh-CN', tasks: '自动化任务', time: '时间', second: '秒', zone: '时区' },
])('automation pickers ($locale)', (copy) => {
  it.each(['clock', 'zone'] as const)('ellipsizes the %s labels and keeps vertical choices reachable at 500% zoom', async (kind) => {
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
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 5 })
      await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(5)
      await expectContained(panel)

      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      if (kind === 'clock') {
        await expectEllipsizedText(panel.locator('[role="option"] > span'))
        const columns = panel.getByRole('listbox')
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
        await last.click()
        await expect.poll(() => trigger.textContent()).toMatch(/:59$/)
      } else {
        await expectEllipsizedText(panel.locator('[role="menuitem"] > span'))
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
        await last.click()
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
