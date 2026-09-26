/** Built workspace chrome with a controlled Desktop carrier; no Electron or installer is exercised. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { presentDesktopUpdate } from '../../desktop/src/update-presentation.ts'
import { en } from '../../desktop/src/locale.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'

// Mirrors the preload's presentation-only API; importing Client projects would mix compiler faces.
type Presentation = ReturnType<typeof presentDesktopUpdate>
interface CarrierFixture {
  publish(state: Presentation): void
  opens: number
  listeners: Set<(state: Presentation) => void>
}
type FixtureWindow = Window & typeof globalThis & { updateFixture: CarrierFixture }

describe('web e2e: Desktop update workspace chrome', () => {
  it.each(['zh-CN', 'en-US'])('renders update states and routes explicit actions in %s', async (locale) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale })
        await page.addInitScript(() => {
          let current: Presentation = { phase: 'idle' }
          const listeners = new Set<(state: Presentation) => void>()
          const fixture: CarrierFixture = {
            opens: 0, listeners,
            publish(state) { current = state; for (const listener of listeners) listener(state) },
          }
          Object.assign(window, {
            updateFixture: fixture,
            dshDesktop: { protocolVersion: 1, updates: {
              status: async () => current,
              open: async () => { fixture.opens += 1 },
              subscribe(listener: (state: Presentation) => void) { listeners.add(listener); return () => listeners.delete(listener) },
            } },
          })
        })
        const tripwire = watchConsole(page)
        const evidenceRoot = fileURLToPath(new URL('../../desktop/.desktop-build/qualification/', import.meta.url))
        await mkdir(evidenceRoot, { recursive: true })
        const evidence = await mkdtemp(join(evidenceRoot, `workspace-updates-${locale}-`))
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.waitForSelector('[class*="frame"]')
          await expect.poll(() => page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
          const availableLabel = locale === 'zh-CN' ? '新版本' : 'Update'
          const retryLabel = locale === 'zh-CN' ? '重试更新' : 'Retry update'
          const errorDetail = locale === 'zh-CN' ? '下载更新失败，请重试。' : 'Could not download the update. Please try again.'
          const readyLabel = locale === 'zh-CN' ? '安装并重启' : 'Install and Restart'
          const version = '0.1.5-nightly.20260911'
          // The carrier classification deliberately uses English shell copy; Web copy follows its own locale.
          const available = presentDesktopUpdate({ phase: 'available', version }, en)
          const publish = async (state: Presentation) => page.evaluate((value) => {
            (window as FixtureWindow).updateFixture.publish(value)
          }, state)
          const opens = async () => page.evaluate(() => (window as FixtureWindow).updateFixture.opens)
          await publish(available)
          const update = page.getByRole('button', { name: availableLabel, exact: true })
          await update.waitFor()
          expect(await opens()).toBe(0)
          const geometry = await update.boundingBox()
          expect(geometry).not.toBeNull()
          expect(geometry!.x).toBeLessThan(350)
          expect(geometry!.y).toBeGreaterThan(650)
          await page.screenshot({ path: join(evidence, 'available.png') })
          await update.click()
          await expect.poll(opens).toBe(1)

          const progress = presentDesktopUpdate({ phase: 'downloading', version, percent: 58 }, en)
          await publish(progress)
          const downloading = page.getByRole('button', { name: '58%', exact: true })
          await downloading.waitFor()
          expect(await downloading.getAttribute('aria-disabled')).toBe('true')
          expect(await downloading.locator('svg').count()).toBe(1)
          // Force dispatch past Playwright's aria-disabled guard to verify the product's click guard.
          await downloading.click({ force: true })
          expect(await opens()).toBe(1)
          await page.screenshot({ path: join(evidence, 'downloading.png') })

          const collapse = locale === 'zh-CN' ? '收起侧边栏' : 'Collapse sidebar'
          const expand = locale === 'zh-CN' ? '打开侧边栏' : 'Open sidebar'
          await page.getByRole('button', { name: collapse, exact: true }).click()
          const toggle = page.getByRole('button', { name: expand, exact: true })
          const badge = toggle.getByRole('img', { name: '58%', exact: true })
          await badge.waitFor()
          await expect.poll(() => downloading.count()).toBe(0)
          expect(await page.getByRole('img', { name: '58%', exact: true }).count()).toBe(1)
          const updateBackground = await badge.evaluate(element => getComputedStyle(element).backgroundColor)
          await page.screenshot({ path: join(evidence, 'collapsed.png') })

          const error = presentDesktopUpdate({ phase: 'error', version, failedOperation: 'download', message: 'HTTP 503' }, en)
          await publish(error)
          const errorBadge = toggle.getByRole('img', { name: retryLabel, exact: true })
          await errorBadge.waitFor()
          // A failure keeps the update palette; only the label distinguishes it.
          const failedBackground = await errorBadge.evaluate(element => getComputedStyle(element).backgroundColor)
          expect(failedBackground).toBe(updateBackground)
          await errorBadge.hover()
          const tooltip = page.getByRole('tooltip', { name: errorDetail, exact: true })
          await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
          await page.screenshot({ path: join(evidence, 'collapsed-error.png') })
          await toggle.click()
          const retry = page.getByRole('button', { name: retryLabel, exact: true })
          await retry.waitFor()
          await expect.poll(() => errorBadge.count()).toBe(0)
          // The expanding ancestor can move the button after hover's element-only stability check.
          await retry.evaluate(async (element) => {
            const movements = document.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect
              && animation.effect.target instanceof Element && animation.effect.target.contains(element)
              && animation.effect.getComputedTiming().endTime !== Infinity)
            await Promise.all(movements.map(animation => animation.finished))
          })
          await retry.hover()
          await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
          await page.screenshot({ path: join(evidence, 'retry.png') })
          await retry.click()
          await expect.poll(opens).toBe(2)

          await publish(presentDesktopUpdate({ phase: 'ready', version }, en))
          const ready = page.getByRole('button', { name: readyLabel, exact: true })
          await ready.waitFor()
          expect(await ready.getAttribute('aria-disabled')).toBe('false')
          expect(await opens()).toBe(2)
          await page.screenshot({ path: join(evidence, 'ready.png') })
          await ready.click()
          await expect.poll(opens).toBe(3)
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          expect(await page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
          await writeFile(join(evidence, 'result.json'), JSON.stringify({ locale, geometry, updateBackground, failedBackground,
            passed: true, explicitActions: 3, carrier: 'substituted', host: 'real Web composition',
            electron: false, installerExecuted: false }, null, 2) + '\n')
          console.log(`Desktop workspace chrome evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  })
})
