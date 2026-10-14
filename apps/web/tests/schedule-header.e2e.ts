// UI-only geometry for the Automation tasks page; no model calls or task mutations.
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

it('keeps the automation title intact before moving New to another line', async () => {
  const scaffold = await launchWebScaffold()
  try {
    const browser = await chromium.launch()
    try {
      const facts: string[] = []
      for (const language of ['en', 'zh'] as const) {
        const context = await browser.newContext({
          viewport: { width: 1680, height: 1000 },
          locale: language === 'en' ? 'en-US' : 'zh-CN',
          reducedMotion: 'reduce',
        })
        try {
          const page = await context.newPage()
          const consoleWatch = watchConsole(page)
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          const title = language === 'en' ? 'Automation tasks' : '自动化任务'
          await page.getByRole('button', { name: title, exact: true }).click()
          const panel = page.getByTestId('task-manager-page')
          const heading = panel.getByRole('heading', { name: title, exact: true })
          await heading.waitFor()
          const header = heading.locator('..')
          const create = header.getByRole('button', { name: language === 'en' ? 'New' : '新建', exact: true })
          await page.evaluate(() => document.fonts.ready)
          await create.focus()
          for (const width of [1680, 800, 520, 440, 390, 430, 1024]) {
            await page.setViewportSize({ width, height: 1000 })
            // The title keeps its natural width at every viewport width, so New
            // stays beside it here; the squeeze case below is what moves it down.
            await expect.poll(() => header.evaluate((element) => {
              const title = element.querySelector('h1')!
              const button = element.querySelector('button')!
              const titleRect = title.getBoundingClientRect()
              const buttonRect = button.getBoundingClientRect()
              const headerRect = element.getBoundingClientRect()
              const range = document.createRange()
              range.selectNodeContents(title)
              const titleLines = Array.from(range.getClientRects())
              return {
                titleSingleLine: titleLines.length === 1,
                buttonSingleLine: button.scrollHeight <= button.clientHeight,
                placement: buttonRect.left >= titleRect.right - 1
                  ? 'beside' as const
                  : buttonRect.top >= titleRect.bottom - 1 ? 'below' as const : 'overlapping' as const,
                contained: titleRect.left >= headerRect.left - 1 && titleRect.right <= headerRect.right + 1
                  && buttonRect.left >= headerRect.left - 1 && buttonRect.right <= headerRect.right + 1,
                focused: document.activeElement === button,
              }
            })).toEqual({
              titleSingleLine: true, buttonSingleLine: true, placement: 'beside', contained: true, focused: true,
            })
            facts.push(`${language} ${width}px: title and New single-line, New beside the title; contained; New retains focus`)
          }
          if (language === 'en') {
            // 509px collapses the left sidebar to its rail; expanding it leaves the
            // page column narrow enough (measured 172px) to force the wrap.
            await page.setViewportSize({ width: 509, height: 1000 })
            await page.getByRole('button', { name: 'Open sidebar', exact: true }).first().click()
            await expect.poll(() => header.evaluate((element) => {
              const title = element.querySelector('h1')!
              const button = element.querySelector('button')!
              const titleRect = title.getBoundingClientRect()
              const buttonRect = button.getBoundingClientRect()
              const range = document.createRange()
              range.selectNodeContents(title)
              return {
                titleSingleLine: range.getClientRects().length === 1,
                placement: buttonRect.left >= titleRect.right - 1
                  ? 'beside' as const
                  : buttonRect.top >= titleRect.bottom - 1 ? 'below' as const : 'overlapping' as const,
              }
            })).toEqual({ titleSingleLine: true, placement: 'below' })
            facts.push('en 509px with sidebar expanded: title single-line; New moves below the title')
          }
          expect(consoleWatch.pageErrors).toEqual([])
        } finally {
          await context.close()
        }
      }
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/schedule-header.expected.md', import.meta.url)),
        `# Automation tasks header\n\n${facts.join('\n')}`,
        webSnapshotMode(),
      )
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
