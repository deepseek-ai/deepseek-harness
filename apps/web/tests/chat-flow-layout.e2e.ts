/** Cold history retains Chat spacing through the flow slot's display:contents anchor. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, selectedSessionFixture, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it.each(['turn-tail-actions', 'goal-multi-turn-actions', 'present'] as const)(
  'preserves process and answer spacing in cold %s history', async (scenario) => {
    const scaffold = await launchWebScaffold({})
    onTestFinished(() => scaffold.close())
    if (scenario === 'present') {
      await writeFile(join(scaffold.workspaceCwd, 'report.txt'), 'DELIVERED_REPORT\n')
      await writeFile(join(scaffold.workspaceCwd, '说明.txt'), 'DELIVERED_NOTE\n')
    }
    const fixture = await selectedSessionFixture(fileURLToPath(
      new URL(`../../../snapshots/web/${scenario}/session.v3.jsonl`, import.meta.url),
    ))
    await seedSession(scaffold, await readFile(fixture, 'utf8'), `flow-layout-${scenario}`)
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    const controls = page.locator('[data-turn-process]')
    await expect.poll(() => controls.count()).toBe(scenario === 'goal-multi-turn-actions' ? 2 : 1)
    const process = controls.first()
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    expect(await process.evaluate(element => element.closest('[data-slot="conversation.chat.flow"]') !== null)).toBe(true)

    if (scenario === 'goal-multi-turn-actions') {
      const trigger = page.locator('[data-turn-trigger]').first()
      await process.click()
      for (const fontSize of [10, 14, 22]) {
        await scaffold.ctx.settings.update('ui-theme', { fontSize })
        await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')))
          .toBe(`${String(fontSize)}px`)
        const group = page.locator('[data-process-activity]:visible').first()
        expect(await process.evaluate(element => element.getBoundingClientRect().top))
          .toBe(await trigger.evaluate(element => element.getBoundingClientRect().bottom) + 16)
        expect(await group.evaluate(element => element.getBoundingClientRect().top))
          .toBe(await process.evaluate(element => element.getBoundingClientRect().bottom) + 16)
      }
    } else {
      const answer = page.getByText(scenario === 'present' ? 'PRESENT_DONE' : 'DONE', { exact: true })
      await answer.waitFor()
      const answerBounds = await answer.evaluate((element) => {
        const seat = element.closest('[data-chat-flow-kind="assistant-step"]')
        if (seat === null) throw new Error('final answer has no Chat seat')
        const { top, bottom } = seat.getBoundingClientRect()
        return { top, bottom }
      })
      expect(answerBounds.top).toBe(await process.evaluate(element => element.getBoundingClientRect().bottom) + 16)
      if (scenario === 'present') {
        const geometry = await page.locator('[data-presented-files-row]').evaluate((grid) => {
          const root = grid.parentElement
          const tail = root?.closest('[data-turn-tail]')
          const actions = tail?.querySelector('button[aria-label="Copy"]')?.parentElement
          if (root === null || actions == null) throw new Error('presented files have no Turn footer')
          return { top: root.getBoundingClientRect().top, bottom: root.getBoundingClientRect().bottom,
            actionsTop: actions.getBoundingClientRect().top }
        })
        expect(geometry.top - answerBounds.bottom).toBeCloseTo(16, 1)
        expect(geometry.actionsTop - geometry.bottom).toBeCloseTo(20, 1)
      }
    }
    expect(console.pageErrors).toEqual([])
  },
)
