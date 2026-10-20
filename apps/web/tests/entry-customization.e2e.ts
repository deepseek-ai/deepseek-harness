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

  it('unpins a sidebar panel across reloads while its panel stays reachable from More', async () => {
    onTestFailed(() => saveFailureShot(page, 'entry-customization'))
    const nav = page.getByRole('navigation', { name: 'Global panels' })
    const plugins = nav.getByRole('button', { name: 'Plugins', exact: true })
    const tasks = nav.getByRole('button', { name: 'Automation tasks', exact: true })
    const more = nav.getByRole('button', { name: 'More', exact: true })
    await plugins.waitFor()
    await tasks.waitFor()
    await more.waitFor()
    const menu = page.getByRole('menu')

    await more.click()
    expect(await menu.getByRole('menuitem', { name: 'Plugins', exact: true }).count()).toBe(0)
    await menu.getByRole('menuitem', { name: 'Unpin from left sidebar: Automation tasks', exact: true }).click()
    await tasks.waitFor({ state: 'detached' })
    await menu.getByRole('menuitem', { name: 'Automation tasks', exact: true }).click()
    await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
    // The selected panel keeps its row until another panel is selected.
    await tasks.waitFor()
    expect(await tasks.getAttribute('aria-current')).toBe('page')
    await plugins.click()
    await tasks.waitFor({ state: 'detached' })
    expect(await plugins.getAttribute('aria-current')).toBe('page')

    await page.reload({ waitUntil: 'load' })
    await plugins.waitFor()
    await more.waitFor()
    expect(await tasks.count()).toBe(0)
    await more.click()
    await menu.getByRole('menuitem', { name: 'Pin to left sidebar: Automation tasks', exact: true }).click()
    await tasks.waitFor()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
