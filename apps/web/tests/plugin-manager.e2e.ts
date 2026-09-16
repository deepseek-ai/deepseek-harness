// Web e2e scenario: the plugin manager page behind the sidebar's Plugins entry over a
// managed scaffold profile: installed bundles, their rows, and bundle enablement. Zero
// model calls: everything is client state plus the profile files and the settings
// document, so there is no fixture and a stray stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/plugin-manager', import.meta.url))
const MANAGER_EXPECTED = join(SNAPSHOT_DIR, 'manager.expected.md')
const LIVE_EXPECTED = join(SNAPSHOT_DIR, 'live-enabled.expected.md')
const FIXTURE_PLUGINS = fileURLToPath(new URL('./fixtures/plugins', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: plugin manager', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: join(FIXTURE_PLUGINS, 'fixture-bundle') }] },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Close any open settings dialog, so the sidebar and the main column are clickable. */
  async function closeSettings() {
    if (await page.getByRole('dialog', { name: '设置' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    }
  }

  /** Select the sidebar's Plugins entry and wait for the management page in the main column. */
  async function openPluginsPanel() {
    await closeSettings()
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 10_000 })
    return panel
  }

  /** One file under the harness home, or the empty string while it does not exist. */
  async function homeFile(...segments: string[]): Promise<string> {
    return readFile(join(scaffold.harnessHome, ...segments), 'utf8').catch(() => '')
  }

  it('lists the installed bundles with their switches and leaves the installation\'s own to Settings', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-list'))
    const panel = await openPluginsPanel()

    await panel.getByText('bundle', { exact: true }).waitFor({ timeout: 20_000 })
    const toggle = panel.getByRole('switch', { name: '启用 bundle' })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    // The profile's own group holds its one bundle; the installation's optional bundles form the built-in
    // group, and its other bundles stay off the page.
    expect(await panel.locator('[data-plugin-group="bundles"] [data-plugin-package]').count()).toBe(1)
    expect(await panel.locator('[data-plugin-group="builtin"] [data-plugin-package]').count()).toBe(3)
    // A bundle that is off still shows the rows its patch declares, without switches.
    await panel.getByRole('button', { name: '查看 bundle' }).click()
    await panel.locator('[data-plugin-row]', { hasText: 'fixture-row' }).waitFor({ timeout: 10_000 })
    expect(await panel.getByRole('switch', { name: '启用组件 fixture-row' }).count()).toBe(0)
    await panel.getByRole('button', { name: '卸载 bundle' }).waitFor({ timeout: 5_000 })
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    await expect.poll(() => panel.getByRole('button', { name: '卸载 bundle' }).count(), { timeout: 5_000 }).toBe(0)

    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MANAGER_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('checks a spec before installing it and words what the check refused', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-install'))
    const panel = await openPluginsPanel()
    await panel.getByRole('button', { name: '添加插件', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '添加插件' })
    await dialog.waitFor({ timeout: 10_000 })
    const field = dialog.getByRole('textbox', { name: '包名或地址' })
    const install = dialog.getByRole('button', { name: '安装', exact: true })
    expect(await install.isDisabled()).toBe(true)
    // A name the list already shows is refused without asking the Host.
    await field.fill('@fixture/bundle')
    await install.click()
    await dialog.getByRole('alert').waitFor({ timeout: 5_000 })
    expect(await dialog.getByRole('alert').textContent()).toBe('该插件已安装')
    // A path the Host cannot read as a package is refused with its reason, and the spec stays editable.
    await field.fill(join(scaffold.harnessHome, 'no-such-plugin'))
    await install.click()
    await expect.poll(() => dialog.getByRole('alert').textContent(), { timeout: 10_000 }).toBe('该路径不存在或不是有效的插件包')
    expect(await field.isDisabled()).toBe(false)
    // A name the registry would refuse never reaches it.
    await field.fill('Not A Package')
    await install.click()
    await expect.poll(() => dialog.getByRole('alert').textContent(), { timeout: 10_000 }).toContain('无法识别这个包名或地址')
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '添加插件' }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('enables a bundle into the profile manifest, mounts its rows live, and switches one of them', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-enable'))
    const panel = await openPluginsPanel()
    const toggle = panel.getByRole('switch', { name: '启用 bundle' })
    await toggle.waitFor({ timeout: 20_000 })
    const mounted = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'fixture-row')
    expect(mounted()?.fiber?.state).toBeUndefined()

    await toggle.click()

    const bundles = async () => (JSON.parse(await homeFile('profiles', 'scaffold', 'package.json')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles
    await expect.poll(bundles, { timeout: 10_000 }).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@fixture/bundle'])
    // A live profile: the row mounts once the whole tree recomposed, the switch is on, and nothing waits for a restart.
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).toBe(2)
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true')
    expect(await panel.getByText(/下次启动生效/).count()).toBe(0)
    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(LIVE_EXPECTED, snapshot, MODE)
    // The pack's page lists its rows as the Host runs them, each with a switch that writes the profile patch.
    await panel.getByRole('button', { name: '查看 bundle' }).click()
    const rowSwitch = panel.getByRole('switch', { name: '启用组件 fixture-row' })
    await rowSwitch.waitFor({ timeout: 10_000 })
    expect(await rowSwitch.getAttribute('aria-checked')).toBe('true')
    await rowSwitch.click()
    await expect.poll(async () => (await homeFile('profiles', 'scaffold', 'cordis.patch.yml')).includes('fixture-row'), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => rowSwitch.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('false')
    // A disabled entry keeps its disposed fiber; only an active one counts as mounted.
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).not.toBe(2)
    await rowSwitch.click()
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).toBe(2)
    await panel.getByRole('button', { name: '返回插件列表' }).click()

    await toggle.click()
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).not.toBe(2)
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['manager.expected.md', 'live-enabled.expected.md'])
  })
})


describe('web e2e: startup-applied plugin management', () => {
  it('saves a bundle selection that waits for the next start and keeps its rows read-only', async () => {
    const scaffold = await launchWebScaffold({
      profile: { hmr: false, packages: [{ dir: join(FIXTURE_PLUGINS, 'fixture-bundle') }] },
    })
    let browser: Browser | undefined
    try {
      browser = await chromium.launch()
      const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      const tripwire = watchConsole(page)
      onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-live'))
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      const toggle = panel.getByRole('switch', { name: '启用 bundle' })
      await toggle.waitFor({ timeout: 20_000 })
      const mounted = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'fixture-row')
      const bundles = async () => {
        const text = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'package.json'), 'utf8')
        return (JSON.parse(text) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
      }
      expect(mounted()?.fiber?.state).toBeUndefined()
      await toggle.click()
      // The selection is saved and the switch turns on, but nothing mounts before the next start; a toast says so.
      await expect.poll(bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@fixture/bundle'])
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await page.getByText('更改将在下次启动生效', { exact: true }).waitFor({ timeout: 10_000 })
      expect(mounted()?.fiber?.state).toBeUndefined()
      // The pack's page lists its rows from their declarations, with no live entry to switch.
      await panel.getByRole('button', { name: '查看 bundle' }).click()
      await panel.locator('[data-plugin-row]', { hasText: 'fixture-row' }).waitFor({ timeout: 10_000 })
      expect(await panel.getByRole('switch', { name: '启用组件 fixture-row' }).isDisabled()).toBe(true)
      await panel.getByRole('button', { name: '返回插件列表' }).click()

      await toggle.click()
      await expect.poll(bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await browser?.close()
      await scaffold.close()
    }
  }, 60_000)
})
