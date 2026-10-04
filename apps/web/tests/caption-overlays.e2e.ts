/** Browser geometry for settings, expanded plugin dialogs, and their menus under Windows caption markers. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

it('keeps settings and expanded plugin dialogs clear of the Windows caption across fullscreen transitions', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [] },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 520, height: 600 }, locale: ZH_BROWSER_LOCALE })
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-windows-titlebar', '')
        document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
      })
      const reopenSidebar = page.getByRole('button', { name: '打开侧边栏', exact: true })
      if (await reopenSidebar.isVisible()) await reopenSidebar.click()
      await openSettings(page, 'zh')
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      const settingsMask = settings.locator('..').locator(':scope > [aria-hidden="true"]')
      for (const fullscreen of [false, true, false]) {
        await page.evaluate(value => document.documentElement.toggleAttribute('data-fullscreen', value), fullscreen)
        const margin = fullscreen ? 24 : 60
        await expect.poll(async () => (await settings.boundingBox())?.y).toBe(margin)
        expect((await settings.boundingBox())?.height).toBe(600 - 2 * margin)
        expect((await settingsMask.boundingBox())?.y).toBe(fullscreen ? 0 : 40)
        expect((await settings.locator('..').boundingBox())?.height).toBe(600)
      }
      expect(await page.evaluate(() => document.elementFromPoint(300, 20)?.getAttribute('role'))).toBe('presentation')
      await page.mouse.click(300, 20)
      expect(await settings.isVisible()).toBe(true)
      await settings.getByRole('button', { name: '工作区内修改', exact: true }).click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const menuRect = await menu.boundingBox()
      expect(menuRect?.y).toBeGreaterThanOrEqual(60)
      expect(menuRect!.y + menuRect!.height).toBeLessThanOrEqual(588)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      expect(await settings.isVisible()).toBe(true)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      if (await reopenSidebar.isVisible()) await reopenSidebar.click()
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      await page.locator('[data-plugin-panel]').getByRole('button', { name: '添加插件', exact: true }).click()
      const plugin = page.getByRole('dialog', { name: '添加插件', exact: true })
      await plugin.getByRole('button', { name: '插件安装引导和示例', exact: true }).click()
      await expect.poll(() => plugin.locator('button[aria-expanded="true"]').count()).toBe(1)
      for (const fullscreen of [false, true, false]) {
        await page.evaluate(value => document.documentElement.toggleAttribute('data-fullscreen', value), fullscreen)
        const margin = fullscreen ? 24 : 60
        // The dialog is content-sized: it fills the available height only while its content needs it,
        // and otherwise stays centered inside the same clearances.
        await expect.poll(async () => {
          const box = await plugin.boundingBox()
          return box !== null && box.y >= margin && box.y + box.height <= 600 - margin
        }, { timeout: 5_000 }).toBe(true)
        expect((await plugin.locator('..').locator(':scope > [aria-hidden="true"]').boundingBox())?.y).toBe(fullscreen ? 0 : 40)
        expect(await plugin.getByRole('button', { name: '关闭', exact: true }).isVisible()).toBe(true)
        expect(await plugin.getByRole('button', { name: '安装', exact: true }).isVisible()).toBe(true)
      }
      await plugin.getByRole('button', { name: /^安装源/ }).click()
      const registry = page.locator('[data-install-registry]')
      await registry.waitFor()
      const registryRect = await registry.boundingBox()
      expect(registryRect!.y).toBeGreaterThanOrEqual(60)
      expect(registryRect!.y + registryRect!.height).toBeLessThanOrEqual(588)
      await page.keyboard.press('Escape')
      await registry.waitFor({ state: 'hidden' })
      expect(await plugin.isVisible()).toBe(true)
      await page.keyboard.press('Escape')
      await plugin.waitFor({ state: 'hidden' })
      for (const platform of ['darwin', 'browser']) {
        await page.evaluate((value) => {
          document.documentElement.removeAttribute('data-windows-titlebar')
          document.documentElement.removeAttribute('data-fullscreen')
          if (value === 'darwin') document.documentElement.setAttribute('data-platform', value)
          else document.documentElement.removeAttribute('data-platform')
        }, platform)
        if (await reopenSidebar.isVisible()) await reopenSidebar.click()
        await openSettings(page, 'zh')
        await expect.poll(async () => (await settings.boundingBox())?.y).toBe(platform === 'darwin' ? 68 : 24)
        expect((await settingsMask.boundingBox())?.y).toBe(0)
        await page.keyboard.press('Escape')
        await settings.waitFor({ state: 'hidden' })
      }
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
