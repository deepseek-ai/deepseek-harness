// UI-only phone geometry for the Automation tasks page: no text field it owns
// sits under the 16px touch step, so the page never reads wider than the screen
// — iOS Safari zooms the visual viewport for a focused field below it.
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-schedule'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { revealNavigationDrawer } from './support.ts'

const PHONE_TASK_TITLE = 'Review overdue deployment'
const PHONE_PAGE_WIDTH = 390

/** The page's box against the screen, plus the font steps of its text fields. */
interface ViewFacts {
  width: number
  documentWidth: number
  smallestField: number
  name: string
  search: string
  instruction: string
}

/** Open the Automation tasks page and return its panel. */
async function openTaskManager(page: Page, url: string): Promise<Locator> {
  await page.goto(url, { waitUntil: 'load' })
  await revealNavigationDrawer(page, 'zh')
  await page.getByRole('button', { name: '自动化任务', exact: true }).click()
  const panel = page.getByTestId('task-manager-page')
  await panel.getByRole('heading', { name: '自动化任务', exact: true }).waitFor({ timeout: 30_000 })
  await page.evaluate(() => document.fonts.ready)
  return panel
}

/** Read the facts above from the open view. */
async function viewFacts(page: Page): Promise<ViewFacts> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="task-manager-page"]')
    const fields = Array.from(panel?.querySelectorAll('input, textarea, select') ?? [])
    const steps = fields.map(element => Number.parseFloat(getComputedStyle(element).fontSize))
    const step = (selector: string): string => {
      const element = document.querySelector(selector)
      return element === null ? 'absent' : getComputedStyle(element).fontSize
    }
    return {
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      smallestField: steps.length === 0 ? -1 : Math.min(...steps),
      name: step('[class*="_editorField"] input'),
      search: step('[class*="_searchField"] input'),
      instruction: step('[class*="_instruction"]'),
    }
  })
}

it('keeps the automation page on screen with its text fields at the touch step', async () => {
  const scaffold = await launchWebScaffold()
  const url = scaffold.authenticatedUrl
  try {
    await scaffold.ctx.schedule.create({
      prompt: 'Check the deployment log', title: PHONE_TASK_TITLE,
      timing: { kind: 'at', at: '2099-08-25T12:08:00.000Z' }, target: { kind: 'new_once' },
    })
    const browser: Browser = await chromium.launch()
    try {
      // A coarse pointer is the touch device, so the phone context takes the
      // 16px step.
      const phone = await browser.newContext({
        viewport: { width: PHONE_PAGE_WIDTH, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'zh-CN',
      })
      const phonePage = await phone.newPage()
      const phoneConsole = watchConsole(phonePage)
      const phonePanel = await openTaskManager(phonePage, url)
      await expect.poll(() => viewFacts(phonePage)).toEqual({
        width: PHONE_PAGE_WIDTH,
        documentWidth: PHONE_PAGE_WIDTH,
        smallestField: 16,
        name: 'absent',
        search: '16px',
        instruction: 'absent',
      })
      // The editor keeps the touch floor for its name and instruction fields.
      await phonePanel.getByRole('button', { name: PHONE_TASK_TITLE, exact: true }).click()
      await phonePanel.locator('[class*="_detailScroll"]').waitFor({ timeout: 10_000 })
      await phonePanel.getByRole('button', { name: '编辑', exact: true }).click()
      await expect.poll(() => viewFacts(phonePage)).toEqual({
        width: PHONE_PAGE_WIDTH,
        documentWidth: PHONE_PAGE_WIDTH,
        smallestField: 16,
        name: '16px',
        search: '16px',
        instruction: '16px',
      })
      await phone.close()

      // A fine pointer keeps the compact steps: the floor is pointer-scoped.
      const desktop = await browser.newContext({ viewport: { width: 1024, height: 800 }, locale: 'zh-CN' })
      const desktopPage = await desktop.newPage()
      const desktopConsole = watchConsole(desktopPage)
      const desktopPanel = await openTaskManager(desktopPage, url)
      await expect.poll(() => viewFacts(desktopPage)).toEqual({
        width: 1024,
        documentWidth: 1024,
        smallestField: 14,
        name: 'absent',
        search: '14px',
        instruction: 'absent',
      })
      await desktopPanel.getByRole('button', { name: PHONE_TASK_TITLE, exact: true }).click()
      await desktopPanel.locator('[class*="_detailScroll"]').waitFor({ timeout: 10_000 })
      await desktopPanel.getByRole('button', { name: '编辑', exact: true }).click()
      await expect.poll(() => viewFacts(desktopPage)).toEqual({
        width: 1024,
        documentWidth: 1024,
        smallestField: 14,
        name: '14px',
        search: '14px',
        instruction: '14px',
      })
      await desktop.close()

      expect(phoneConsole.pageErrors).toEqual([])
      expect(phoneConsole.warnings).toEqual([])
      expect(desktopConsole.pageErrors).toEqual([])
      expect(desktopConsole.warnings).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
}, 180_000)
