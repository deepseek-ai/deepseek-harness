// A trusted remote browser uses the same Host settings service as loopback:
// welcome acknowledgement, model configuration and appearance persist in the
// Host profile patch across reloads and independent browser contexts.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss,
  launchWebScaffold, watchConsole, webSnapshotMode, WELCOME_NOTICE_COPY,
  type WebScaffold,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()

/**
 * A loading welcome store hides the notice, so absence is conclusive only
 * after the shared settings read has enabled the Models view.
 * @param page - the loaded page.
 * @returns the open settings dialog on its Models view.
 */
async function expectOnboardingSettled(page: Page): Promise<Locator> {
  await page.waitForSelector('#root', { timeout: 30_000 })
  await page.getByRole('textbox', { name: '选择工作区' }).waitFor({ timeout: 30_000 })
  await openSettings(page, 'zh')
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: '模型', exact: true }).click()
  await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor({ timeout: 15_000 })
  expect(await page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title }).count()).toBe(0)
  return dialog
}

describe.skipIf(MODE === 'record')('web e2e: trusted remote host preferences', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      remoteAuthority: 'remote.localhost',
      welcomeNoticePending: true,
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Reload the page and absorb the one expected reload-time connection loss. */
  async function reloadPage(): Promise<void> {
    const warnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warnings)
  }

  it('persists welcome acknowledgement, model configuration, and appearance across reloads and browser contexts', async () => {
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(
      () => page.locator('#root').evaluate(root => (root as HTMLElement).inert),
      { timeout: 15_000 },
    ).toBe(false)
    const settingsPath = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
    await expect.poll(() => readFile(settingsPath, 'utf8'), { timeout: 10_000 })
      .toContain('welcomeNoticeVersion:')

    // The acknowledged version is durable, so the notice stays away after a reload.
    await reloadPage()
    const dialog = await expectOnboardingSettled(page)

    await page.emulateMedia({ colorScheme: 'light' })
    await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).click()
    await dialog.getByLabel('提供商', { exact: true }).selectOption('minimax-cn')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => readFile(settingsPath, 'utf8'), { timeout: 10_000 })
      .toContain('minimax-cn: {}')

    await dialog.getByRole('button', { name: '通用设置', exact: true }).click()
    await dialog.getByRole('button', { name: '深色', exact: true }).click()
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
    await expect.poll(() => readFile(settingsPath, 'utf8'), { timeout: 10_000 })
      .toContain('preference: dark')

    await reloadPage()
    await expectOnboardingSettled(page)
    await dialog.getByRole('button', { name: '编辑 minimax-cn', exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme'), { timeout: 15_000 }).toBe('')
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])

    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
      colorScheme: 'light',
    })
    try {
      const freshPage = await context.newPage()
      const freshTripwire = watchConsole(freshPage)
      await freshPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const freshDialog = await expectOnboardingSettled(freshPage)
      await freshDialog.getByRole('button', { name: '编辑 minimax-cn', exact: true }).waitFor({ timeout: 15_000 })
      await expect.poll(
        () => freshPage.locator('body').getAttribute('data-ds-dark-theme'),
        { timeout: 15_000 },
      ).toBe('')
      expect(freshTripwire.warnings).toEqual([])
      expect(freshTripwire.pageErrors).toEqual([])
    } finally {
      await context.close()
    }
  }, 180_000)
})
