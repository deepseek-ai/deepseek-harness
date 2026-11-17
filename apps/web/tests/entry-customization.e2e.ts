/** Default-loaded entry controls activate through the real Web profile and Loader. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold, type WebConsoleTripwire } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('default navigation entry customization', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: WebConsoleTripwire

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('keeps navigation outside More and offers only browsing and creation after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'entry-customization'))
    const nav = page.getByRole('navigation', { name: 'Global panels' })
    const tasks = nav.getByRole('button', { name: 'Automation tasks', exact: true })
    const more = nav.getByRole('button', { name: 'More', exact: true })
    await tasks.waitFor()
    await tasks.click()
    await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
    for (const reload of [false, true]) {
      if (reload) {
        await page.reload({ waitUntil: 'load' })
        await tasks.click()
        await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
      }
      await tasks.waitFor()
      await more.click()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).waitFor()
      expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['Browse other plugins', 'Create your plugin'])
      expect(await menu.getByRole('separator').count()).toBe(0)
      expect(await tasks.getAttribute('aria-current')).toBe('page')
      await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
      await menu.waitFor({ state: 'detached' })
      expect(await nav.getByRole('button', { name: 'Plugins', exact: true }).getAttribute('aria-current')).toBe('page')
      await tasks.click()
      await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
