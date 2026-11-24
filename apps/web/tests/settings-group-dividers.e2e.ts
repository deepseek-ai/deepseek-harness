/** Real external settings plugins retain internal lines and share only registration-end dividers. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings, saveFailureShot } from './support.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/plugins/', import.meta.url))
const CASES = [
  { fixture: 'legacy', slot: 'settings.general.item' },
  { fixture: 'grouped', slot: 'settings.general.group.notifications.item' },
  { fixture: 'custom', slot: 'settings.general.group.repro.item' },
] as const

async function setTheme(page: Page, colorScheme: 'dark' | 'light') {
  await page.emulateMedia({ colorScheme })
  await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')))
    .toBe(colorScheme === 'dark')
}

async function assertBuiltInCardEdges(settings: Locator, hairline: string) {
  for (const group of ['data', 'updates']) {
    const outlet = settings.locator(`[data-slot="settings.general.group.${group}.item"]`)
    const roots = outlet.locator(':scope > [data-slot-item] > *')
    await roots.waitFor()
    expect(await roots.count()).toBe(1)
    expect((await borders(roots)).bottom).toBe('0px')
    expect(await outlet.evaluate(element => getComputedStyle(element.parentElement!.parentElement!.parentElement!).borderBottomWidth))
      .toBe(hairline)
  }
}

async function borders(row: Locator) {
  return row.evaluate((element) => {
    const style = getComputedStyle(element)
    return { top: style.borderTopWidth, bottom: style.borderBottomWidth }
  })
}

for (const { fixture, slot } of CASES) {
  it(`keeps registration-end dividers in ${slot} across themes, null output and Loader removal`, async () => {
    const scaffold = await launchWebScaffold({
      extraInstallAnchors: [join(FIXTURES, `fixture-settings-slots-${fixture}`, 'package.json')],
    })
    onTestFinished(() => scaffold.close())
    const entryId = await scaffold.ctx.loader.create({ name: `@fixture/settings-slots-${fixture}` })
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-settings-dividers-${fixture}`))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    const outlet = settings.locator(`[data-slot="${slot}"]`)
    const row = (id: string) => outlet.locator(`[data-slot-repro-row="${id}"]`)
    await row('bordered').waitFor()
    expect(await outlet.locator(':scope > [data-slot-item]').count()).toBeGreaterThanOrEqual(5)
    expect(await outlet.locator(':scope > [data-slot-item]:empty').count()).toBe(2)
    expect(await outlet.locator('[data-slot-repro-row]').evaluateAll(elements => elements.map(element => element.getAttribute('data-slot-repro-row'))))
      .toEqual(['single', 'pairA', 'pairB', 'bordered'])
    expect(await row('pairA').locator('..').evaluate(element => [...element.children].map(child => child.getAttribute('data-slot-repro-row'))))
      .toEqual(['pairA', 'pairB'])

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      // Chromium can quantize the fixture's declared 0.5px internal line to one CSS pixel.
      const hairline = (await borders(row('pairB'))).top
      expect(['0.5px', '1px']).toContain(hairline)
      expect(await borders(row('single'))).toEqual({ top: '0px', bottom: hairline })
      expect(await borders(row('pairA'))).toEqual({ top: '0px', bottom: '0px' })
      expect(await borders(row('pairB'))).toEqual({ top: hairline, bottom: hairline })
      expect(await borders(row('bordered'))).toEqual({ top: '0px', bottom: '0px' })
      await assertBuiltInCardEdges(settings, hairline)
    }

    await row('bordered').getByRole('checkbox').click()
    await row('bordered').waitFor({ state: 'detached' })
    await expect.poll(() => outlet.locator(':scope > [data-slot-item]:empty').count()).toBe(3)
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      const hairline = (await borders(row('pairB'))).top
      expect(['0.5px', '1px']).toContain(hairline)
      expect(await borders(row('single'))).toEqual({ top: '0px', bottom: hairline })
      expect(await borders(row('pairA'))).toEqual({ top: '0px', bottom: '0px' })
      expect(await borders(row('pairB'))).toEqual({ top: hairline, bottom: '0px' })
    }

    scaffold.ctx.loader.remove(entryId)
    await expect.poll(() => settings.locator('[data-slot-repro-row]').count()).toBe(0)
    if (fixture === 'custom') {
      await expect.poll(() => settings.getByRole('heading', { name: 'Plugin divider experiment', exact: true }).count()).toBe(0)
      await expect.poll(() => outlet.count()).toBe(0)
    } else {
      expect(await outlet.count()).toBe(1)
      expect(await outlet.locator(':scope > [data-slot-item]:empty').count()).toBe(0)
    }
    expect(tripwire.pageErrors).toEqual([])
  })
}
