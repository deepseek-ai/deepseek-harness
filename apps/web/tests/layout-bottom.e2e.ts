/** Bottom Slot geometry and lifetime in the shipped Web composition. */
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

async function geometry(page: Page) {
  return page.evaluate(() => {
    const bottom = document.querySelector<HTMLElement>('[data-shell-bottom]')!
    const main = document.querySelector('[data-slot="main"]')!.parentElement!
    const sidebar = document.querySelector('[data-slot="sidebar"]')!.parentElement!
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return { top: box.top, height: box.height, bottom: box.bottom }
    }
    return {
      bottom: rect(bottom), main: rect(main), sidebar: rect(sidebar),
      rightbar: rect(document.querySelector('[data-rightbar-col]')!),
      overlay: rect(document.querySelector('[data-shell-overlay]')!),
      handles: [...document.querySelectorAll('[data-side]')].map(rect),
      pageHeight: document.documentElement.scrollHeight,
    }
  })
}

it('reserves bottom content height without remounting it on main-panel navigation', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    extraInstallAnchors: [fileURLToPath(new URL('./fixtures/plugins/fixture-layout-bottom/package.json', import.meta.url))],
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.locator('[data-shell-bottom]').waitFor({ state: 'attached' })
      const expected: string[] = []
      const check = async (height: number, caption = 0) => {
        await expect.poll(async () => (await geometry(page)).bottom.height).toBe(height)
        const result = await geometry(page)
        const viewportHeight = page.viewportSize()!.height
        expect(result.bottom).toEqual({ top: viewportHeight - height, height, bottom: viewportHeight })
        expect(result.main).toEqual({ top: caption, height: viewportHeight - caption - height, bottom: viewportHeight - height })
        expect(result.sidebar).toEqual(result.main)
        expect(result.rightbar).toEqual(result.main)
        expect(result.overlay).toEqual({ top: 0, height: viewportHeight, bottom: viewportHeight })
        for (const handle of result.handles) expect(handle).toEqual(result.main)
        expect(result.pageHeight).toBe(viewportHeight)
        return result
      }
      expected.push(`empty: ${JSON.stringify(await check(0))}`)
      const entryId = await scaffold.ctx.loader.create({ name: '@fixture/layout-bottom' })
      const input = page.getByRole('textbox', { name: 'Bottom input' })
      await input.fill('Retained across main panels')
      const original = await input.elementHandle()
      expected.push(`open: ${JSON.stringify(await check(240))}`)
      await page.getByRole('button', { name: 'Grow bottom', exact: true }).click()
      expected.push(`grown: ${JSON.stringify(await check(360))}`)
      await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.locator('[data-plugin-panel]').waitFor()
      expect(await input.inputValue()).toBe('Retained across main panels')
      expect(await input.evaluate((element, previous) => element === previous, original)).toBe(true)
      await original?.dispose()

      for (const platform of ['darwin', 'windows', 'browser']) {
        await page.evaluate((value) => {
          document.documentElement.removeAttribute('data-platform')
          document.documentElement.toggleAttribute('data-windows-titlebar', value === 'windows')
          if (value === 'darwin') document.documentElement.setAttribute('data-platform', value)
          document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
        }, platform)
        expected.push(`${platform}: ${JSON.stringify(await check(360, platform === 'windows' ? 40 : 0))}`)
      }
      await page.setViewportSize({ width: 520, height: 600 })
      await expect.poll(() => page.locator('[data-shell-bottom]').locator('..').getAttribute('data-sidebar-collapsed')).toBe('true')
      expected.push(`narrow: ${JSON.stringify(await check(360))}`)
      scaffold.ctx.loader.remove(entryId)
      await page.locator('[data-bottom-fixture]').waitFor({ state: 'detached' })
      expected.push(`unregistered: ${JSON.stringify(await check(0))}`)
      const nextEntryId = await scaffold.ctx.loader.create({ name: '@fixture/layout-bottom' })
      await input.waitFor()
      expect(await input.inputValue()).toBe('')
      await check(240)
      await page.getByRole('button', { name: 'Collapse bottom', exact: true }).click()
      expected.push(`collapsed: ${JSON.stringify(await check(0))}`)
      scaffold.ctx.loader.remove(nextEntryId)
      await expect.poll(() => page.locator('[data-slot="shell.bottom"] > *').count()).toBe(0)
      expect(await check(0)).toBeDefined()
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/layout-bottom/geometry.expected.md', import.meta.url)),
        expected.join('\n'), webSnapshotMode())
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
