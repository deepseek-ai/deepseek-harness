/** Account and Session menus share material and keep macOS backings aligned and scoped. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode } from './scaffold.ts'

const expected = fileURLToPath(new URL('./expected/menu-material', import.meta.url))
const seed = new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url)

async function material(menu: Locator) {
  return menu.evaluate((node) => {
    const style = getComputedStyle(node)
    const background = getComputedStyle(node.querySelector(':scope > [aria-hidden="true"]')!)
    return { fill: background.backgroundColor, blur: background.backdropFilter, radius: style.borderRadius, shadow: style.boxShadow }
  })
}

it('shares menu transparency and blur across palettes and follows native menu bounds', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, await readFile(seed, 'utf8'), 'menu-material-session')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const account = page.getByRole('button', { name: 'Account menu', exact: true })
  await account.waitFor()

  const results: Record<string, Awaited<ReturnType<typeof material>>> = {}
  const masks: Record<string, { fill: string; blur: string }> = {}
  for (const platform of ['web', 'darwin']) {
    for (const dark of [false, true]) {
      await page.evaluate(({ platform, dark }) => {
        if (platform === 'darwin') document.documentElement.dataset.platform = platform
        else delete document.documentElement.dataset.platform
        document.body.toggleAttribute('data-ds-dark-theme', dark)
      }, { platform, dark })
      const overlayFill = await page.evaluate(() => {
        const overlay = document.createElement('div')
        overlay.style.background = 'var(--dsw-specific-menu)'
        document.body.appendChild(overlay)
        try { return getComputedStyle(overlay).backgroundColor } finally { overlay.remove() }
      })
      expect(overlayFill).toBe(platform === 'darwin'
        ? dark ? 'rgba(48, 49, 54, 0.94)' : 'rgba(248, 249, 250, 0.94)'
        : dark ? 'rgba(67, 69, 74, 0.45)' : 'rgba(248, 249, 250, 0.58)')
      await account.click()
      const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Settings', exact: true }) })
      await menu.waitFor()
      const appearance = await material(menu)
      expect(appearance).toMatchObject({
        fill: dark ? 'rgba(67, 69, 74, 0.45)' : 'rgba(248, 249, 250, 0.58)',
        blur: 'blur(40px) saturate(1.5)',
      })
      expect(appearance.shadow).toContain(`${dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.04)'} 0px 0px 0px 0.5px`)
      results[`${platform}-${dark ? 'dark' : 'light'}`] = appearance
      const backing = page.locator('[data-menu-backing]')
      if (platform === 'darwin') {
        await backing.waitFor({ state: 'visible' })
        for (const height of [950, 1000]) {
          await page.setViewportSize({ width: 1440, height })
          await expect.poll(async () => {
            const card = await menu.boundingBox()
            const base = await backing.boundingBox()
            return card !== null && base !== null
              && Math.abs(card.x - base.x) < 1 && Math.abs(card.y - base.y) < 1
              && Math.abs(card.width - base.width) < 1 && Math.abs(card.height - base.height) < 1
          }).toBe(true)
        }
        expect(await backing.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none')
      } else {
        expect(await backing.isVisible()).toBe(false)
      }
      await page.keyboard.press('Escape')
      await expect.poll(() => backing.count()).toBe(0)
      await account.click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.waitFor()
      const mask = await settings.locator('..').locator(':scope > [aria-hidden="true"]').evaluate((node) => {
        const style = getComputedStyle(node)
        return { fill: style.backgroundColor, blur: style.backdropFilter }
      })
      expect(mask).toEqual({ fill: dark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.24)', blur: 'none' })
      masks[`${platform}-${dark ? 'dark' : 'light'}`] = mask
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
    }
  }
  await compareOrRefreshGolden(join(expected, 'materials.expected.json'), JSON.stringify(results, null, 2), webSnapshotMode())
  await compareOrRefreshGolden(join(expected, 'modal-masks.expected.json'), JSON.stringify(masks, null, 2), webSnapshotMode())

  const ungrouped = page.getByText('Ungrouped', { exact: true })
  const group = ungrouped.locator('xpath=ancestor::*[@aria-expanded][1]')
  await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
  const action = page.locator('button[aria-label^="Session actions for "]').first()
  await action.locator('xpath=ancestor::*[@role="treeitem"][1]').hover()
  await action.click()
  const sessionMenu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Rename', exact: true }) })
  await sessionMenu.waitFor()
  expect(await material(sessionMenu)).toEqual(results['darwin-dark'])
  await compareOrRefreshGolden(join(expected, 'session-menu.expected.md'),
    await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
  await page.keyboard.press('Escape')
  await expect.poll(() => page.locator('[data-menu-backing]').count()).toBe(0)
})
