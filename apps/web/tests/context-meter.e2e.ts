/** Context details stay inside the viewport with and without Chat's statistics contribution. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { describe, expect, it } from 'vitest'
import { fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const NO_CHAT = fileURLToPath(new URL('./fixtures/context-meter-no-chat.patch.yml', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record').each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('web e2e: context details placement ($name)', ({ engine }) => {
  it.each([true, false])('keeps details visible while resizing the window (Chat statistics: %s)', async (withStats) => {
    const fixture = await selectedSessionFixture(FIXTURE, false)
    const scaffold = await launchWebScaffold({
      replayFixture: fixture,
      compareReplaySession: false,
      paceMs: 5,
      ...withStats ? {} : { extraOverlayPath: NO_CHAT },
    })
    try {
      const browser = await engine.launch()
      try {
        const page = await newEnglishPage(browser)
        const tripwire = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await connectFreshWorkspace(page, scaffold.workspaceCwd)
        const card = page.locator('[data-composer-card]')
        expect(await card.evaluate(element =>
          element.parentElement!.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom,
        )).toBe(0)
        const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
        expect(prompts).toHaveLength(1)
        const settled = scaffold.whenTurnSettled()
        const input = page.locator('[data-composer-input]').first()
        await input.fill(prompts[0]!)
        await input.press('Enter')
        await settled
        const trigger = page.getByRole('button', { name: /% of context used$/ })
        await trigger.waitFor()
        expect(await trigger.textContent()).toMatch(/^\d+%$/)
        expect(await page.getByRole('button', { name: /tok · Cache hit/ }).count()).toBe(withStats ? 1 : 0)
        expect(await card.evaluate((element) => {
          const dock = element.nextElementSibling!
          return {
            above: getComputedStyle(dock).paddingTop,
            below: getComputedStyle(element.parentElement!).paddingBottom,
          }
        })).toEqual({ above: '4px', below: '4px' })
        await trigger.click()
        const panel = page.getByRole('dialog', { name: 'of context used', exact: true })
        await panel.waitFor()
        for (const width of [390, 800, 1280]) {
          await page.setViewportSize({ width, height: 900 })
          await page.locator('[data-sidebar-collapsed="true"]').waitFor({
            state: width <= 800 ? 'attached' : 'detached',
          })
          await page.evaluate(async () => {
            await Promise.all(document.getAnimations()
              .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map(animation => animation.finished.catch(() => undefined)))
          })
          await expect.poll(async () => {
            const rect = await panel.boundingBox()
            return rect !== null && rect.x >= 12 && rect.x + rect.width <= width - 12
              && rect.y >= 12 && rect.y + rect.height <= 888
          }).toBe(true)
        }
        await panel.getByText('System prompt', { exact: true }).click()
        expect(await panel.isVisible()).toBe(true)
        await page.keyboard.press('Escape')
        await panel.waitFor({ state: 'hidden' })
        await trigger.click()
        await panel.waitFor()
        await page.mouse.click(1260, 400)
        await panel.waitFor({ state: 'hidden' })
        const panels = [
          { trigger, name: 'of context used' },
          ...withStats ? [
            { trigger: page.locator('[data-composer-stat="activity"] button'), name: 'Session statistics' },
            { trigger: page.locator('[data-composer-stat="usage"] button'), name: 'Token usage' },
          ] : [],
        ]
        for (const details of panels) {
          await details.trigger.click()
          const dialog = page.getByRole('dialog', { name: details.name, exact: true })
          await dialog.waitFor()
          for (const width of [1280, 800, 390]) {
            await page.setViewportSize({ width, height: 900 })
            await expect.poll(async () => {
              const rect = await dialog.boundingBox()
              const anchor = await details.trigger.boundingBox()
              return rect !== null && anchor !== null
                && rect.x >= 11 && rect.x + rect.width <= width - 11
                && rect.y >= 11 && rect.y + rect.height <= 889
                && Math.abs(anchor.y - rect.y - rect.height - 8) <= 1
            }).toBe(true)
          }
          await page.keyboard.press('Escape')
          await dialog.waitFor({ state: 'hidden' })
        }
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  })
})
