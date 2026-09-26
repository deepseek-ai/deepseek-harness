// Web e2e scenarios: the settings surface — the modal shell (trigger, nav,
// section switching, both close paths), the Appearance preference row (the
// real theme gesture — click 深色 and the whole cascade runs: ThemeRuntime preference -> Host settings
// -> theme/change -> ui-layout's presenter -> body attribute -> alias token +
// browser theme-color metadata)
// the Language row and busy-state Enter preference (both Host-backed), plus
// Permission as the persisted default for subsequently created sessions.
// Zero model calls: everything is pure client + persistence state on a blank
// frame, so there is no fixture and a stray stream would fail loud on the
// open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/settings-chrome', import.meta.url))
const DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'dialog.expected.md')
const PLUGINS_EXPECTED = join(SNAPSHOT_DIR, 'plugins.expected.md')
const PLUGIN_INSTANCES_EXPECTED = join(SNAPSHOT_DIR, 'plugin-instances.expected.md')
// The English fallback surface: a browser naming no shipped language.
const DIALOG_EN_EXPECTED = join(SNAPSHOT_DIR, 'dialog-en.expected.md')
const PLUGIN_ROW_SELECTOR = '[data-plugin-scope="preset"] [data-plugin-entry="tool-subagent"]'
const MODE = webSnapshotMode()
const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
const versionCapture = { replacements: [[version, '{{version}}']] as const }

describe('web e2e: settings modal and General preferences', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      developerTools: false,
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    })
    browser = await chromium.launch()
    // Chinese browser: the shared page asserts the localized settings surface
    // the client derives from it (the English default has its own spec below).
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens the settings dialog, switches sections, and closes by every path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-shell'))
    const trigger = page.getByRole('button', { name: '设置', exact: true })
    expect(await trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    // General is active by default; Permission, Language and Appearance are functional.
    expect(await dialog.getByRole('button', { name: '通用设置' }).getAttribute('aria-current')).toBe('true')
    await dialog.getByRole('button', { name: '工作区内修改' }).waitFor({ timeout: 10_000 })
    await expect.poll(() => dialog.getByText('语言', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => dialog.getByText('外观', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    const openDocument = dialog.getByRole('button', { name: '打开配置文件' })
    await openDocument.waitFor({ timeout: 10_000 })
    let openRequests = 0
    await page.route('**/api/settings/openSettingsDocument', async (route) => {
      const envelope = route.request().postDataJSON() as {
        rpcId: string
        payload: { args: Record<string, never> }
      }
      expect(envelope.payload).toEqual({ args: {} })
      openRequests += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { opened: true } },
        }),
      })
    })
    await openDocument.click()
    await expect.poll(() => openRequests, { timeout: 5_000 }).toBe(1)
    await expect.poll(() => openDocument.isEnabled(), { timeout: 5_000 }).toBe(true)
    await page.unroute('**/api/settings/openSettingsDocument')
    await dialog.getByText(`当前版本：${version}`, { exact: true }).waitFor()
    // Golden of the freshly opened dialog (default zh, General active).
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, versionCapture)
    await compareOrRefreshGolden(DIALOG_EXPECTED, snapshot, MODE)
    // Section switch: aria-current moves (the Models page itself has its own scenario file).
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await expect.poll(() => dialog.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    expect(await dialog.getByRole('button', { name: '通用设置' }).getAttribute('aria-current')).toBeNull()
    // Built-in plugins: the read-only Plugin list, a projection of the same
    // assembled Loader tree, shown as the section's one page; management and
    // configuration live on the sidebar's Plugins panel (its own scenario files
    // drive that page over a profile runtime). Capture one stable shipped row
    // rather than the whole inventory so adding an unrelated plugin does not
    // rewrite this surface's golden.
    await dialog.getByRole('button', { name: '内置插件', exact: true }).click()
    await dialog.getByRole('heading', { name: '内置插件', exact: true }).waitFor({ timeout: 10_000 })
    // Both groups start collapsed; the preset group's header still carries its display-only switcher.
    const presetSwitcher = dialog.getByRole('button', { name: '选择要查看的 Agent 预设' })
    await presetSwitcher.waitFor({ timeout: 10_000 })
    // The shipped default's zh display name comes from the zh dictionaries.
    expect(await presetSwitcher.textContent()).toBe('标准模式（默认）')
    const presetToggle = dialog.getByRole('button', { name: '会话插件', exact: true })
    expect(await presetToggle.getAttribute('aria-expanded')).toBe('false')
    expect(await dialog.locator('[data-plugin-scope="preset"] [data-plugin-entry]').count()).toBe(0)
    await presetToggle.click()
    await dialog.getByRole('button', { name: /^全局/ }).click()
    const pluginRow = dialog.locator(PLUGIN_ROW_SELECTOR)
    await pluginRow.waitFor({ timeout: 10_000 })
    const expectedPluginCount = [...scaffold.ctx.loader.entries()]
      .filter(entry => !entry.options.group)
      .length
    const pluginSearch = dialog.getByRole('searchbox', { name: '搜索插件' })
    expect(await pluginSearch.count()).toBe(1)
    // Every Loader entry appears exactly once in the global group — rows the
    // presets took over included, preset compositions excluded.
    expect(await dialog.locator('[data-plugin-scope="global"] [data-plugin-entry]').count())
      .toBe(expectedPluginCount)
    // The enablement tag is the row's collapsed status: an active fiber draws no
    // dot, so no global row names the active phase. Guard the assertion against
    // matching nothing because no row is enabled.
    expect(await dialog.locator('[data-plugin-scope="global"] [data-plugin-entry] button[aria-label$="已启用"]').count())
      .toBeGreaterThan(0)
    expect(await dialog.locator('[data-plugin-scope="global"] [role="img"][aria-label="运行中"]').count()).toBe(0)
    expect(await dialog.locator('[data-plugin-count]').getAttribute('data-plugin-count'))
      .toBe(String(expectedPluginCount))
    expect(await dialog.getByRole('button', { name: '内置插件', exact: true }).getAttribute('aria-current')).toBe('true')
    // One contribution shows as the page itself, without a tab row.
    expect(await dialog.getByRole('tab').count()).toBe(0)
    expect(await dialog.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current')).toBeNull()
    const pluginsSnapshot = await captureStableAria(
      page,
      PLUGIN_ROW_SELECTOR,
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(PLUGINS_EXPECTED, pluginsSnapshot, MODE)
    await pluginSearch.fill('tool-subagent')
    const instanceRows = [
      ['tool-subagent', '已启用'],
      ['tool-subagent-fork', '已启用'],
      ['tool-subagent-codex', '已停用'],
      ['tool-subagent-claude-code', '已停用'],
    ] as const
    for (const [entryId, status] of instanceRows) {
      const row = dialog.locator(`[data-plugin-scope="preset"] [data-plugin-entry="${entryId}"]`)
      const trigger = row.getByRole('button', { name: `tool-subagent, ${entryId}, ${status}`, exact: true })
      await trigger.waitFor({ timeout: 10_000 })
      expect(await trigger.getAttribute('aria-expanded')).toBe('false')
      const identity = row.locator('code')
      expect(await identity.textContent()).toBe(entryId)
      expect(await identity.getAttribute('title')).toBe(entryId)
    }
    const instancesSnapshot = await captureStableAria(
      page,
      '[data-plugin-scope="preset"] ul',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(PLUGIN_INSTANCES_EXPECTED, instancesSnapshot, MODE)
    await dialog.getByRole('button', {
      name: 'tool-subagent, tool-subagent-claude-code, 已停用',
      exact: true,
    }).click()
    expect(await dialog.locator('[data-plugin-entry="tool-subagent-claude-code"] button')
      .getAttribute('aria-expanded')).toBe('true')
    await pluginSearch.fill('')
    // Close path 1: Escape.
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    // Close path 2: the header close button (focus lands there on open).
    await openSettings(page, 'zh')
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('scrolls overflowing section navigation independently of the title and settings content', async () => {
    const overflowPage = await browser.newPage({ viewport: { width: 1280, height: 768 }, locale: ZH_BROWSER_LOCALE })
    onTestFinished(() => overflowPage.close())
    onTestFailed(() => saveFailureShot(overflowPage, 'web-e2e-settings-navigation'))
    const console = watchConsole(overflowPage)
    await overflowPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(overflowPage, 'zh')
    const dialog = overflowPage.getByRole('dialog', { name: '设置', exact: true })
    const navigation = dialog.getByRole('navigation')
    const list = navigation.locator('[class*="_navList"]')
    const title = navigation.getByText('设置', { exact: true })
    const options = dialog.locator('[class*="_options"]')
    const last = navigation.getByRole('button').last()
    await last.waitFor()
    expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(false)

    // A short viewport overflows the shipped sections without synthetic registrations.
    await overflowPage.setViewportSize({ width: 1280, height: 240 })
    expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const titleBefore = await title.boundingBox()
    const contentBefore = await options.innerText()
    await navigation.getByRole('button').first().hover()
    await overflowPage.mouse.wheel(0, 1000)
    await expect.poll(() => last.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })).toBe(true)
    const navScroll = await list.evaluate(el => el.scrollTop)
    expect(navScroll).toBeGreaterThan(0)
    expect(await title.boundingBox()).toEqual(titleBefore)
    expect(await options.evaluate(el => el.scrollTop)).toBe(0)

    await options.hover()
    await overflowPage.mouse.wheel(0, 1000)
    await expect.poll(() => options.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    expect(await list.evaluate(el => el.scrollTop)).toBe(navScroll)
    expect(await title.boundingBox()).toEqual(titleBefore)
    await last.click()
    await expect.poll(() => last.getAttribute('aria-current')).toBe('true')
    await expect.poll(() => options.innerText()).not.toBe(contentBefore)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  })

  it('stores Permission as the default for future sessions without changing an existing session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-permission'))
    const existing = scaffold.ctx.sessions.create(SessionId('settings-permission-before'))
    expect(existing.snapshotEvents().find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    const selector = dialog.getByRole('button', { name: '工作区内修改' })
    await selector.waitFor({ timeout: 10_000 })
    await expect.poll(() => selector.isEnabled(), { timeout: 5_000 }).toBe(true)
    await selector.click()
    await page.getByRole('menuitem', { name: '仅可查看' }).click()
    await dialog.getByRole('button', { name: '仅可查看' }).waitFor({ timeout: 10_000 })

    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('id: permission')
    expect(document).toContain('defaultPreset: read-only')
    expect(existing.snapshotEvents().find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    const created = scaffold.ctx.sessions.create(SessionId('settings-permission-after'))
    expect(created.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'read-only' }],
      ['sandbox/mode', { mode: 'read-only' }],
      ['approval/policy', { policy: 'ask' }],
    ])

    await dialog.getByRole('button', { name: '仅可查看' }).click()
    await page.getByRole('menuitem', { name: '完全权限' }).click()
    const confirmation = page.getByRole('dialog', { name: '确认启用完全权限？' })
    const enable = confirmation.getByRole('button', { name: '启用完全权限' })
    expect(await enable.isDisabled()).toBe(true)
    await confirmation.getByRole('checkbox').click()
    await enable.click()
    await dialog.getByRole('button', { name: '完全权限' }).waitFor({ timeout: 10_000 })
    const confirmedDocument = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(confirmedDocument).toContain('defaultPreset: danger-full-access')
    const confirmed = scaffold.ctx.sessions.create(SessionId('settings-permission-confirmed'))
    expect(confirmed.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  async function selectTheme(cube: Locator, preference: 'light' | 'dark' | 'system'): Promise<void> {
    // Optimistic UI and a file value from an earlier gesture do not prove this write finished.
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        if (candidate.request().method() !== 'POST'
          || new URL(candidate.url()).pathname !== '/api/settings/mutate') return false
        const { payload: { args } } = candidate.request().postDataJSON() as {
          payload: { args: { ns: string; ops: { op: string; path: string[]; value?: unknown }[] } }
        }
        return args.ns === 'ui-theme' && args.ops.some(op => op.op === 'set'
          && op.path.length === 1 && op.path[0] === 'preference' && op.value === preference)
      }, { timeout: 5_000 }),
      cube.click(),
    ])
    expect(response.ok()).toBe(true)
    const outcome: unknown = await response.json()
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      result: { ok: true, value: { ns: 'ui-theme', value: { preference } } },
    })
  }

  it('uses the persisted dark preference while plugins are still loading', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-boot-theme'))
    await page.emulateMedia({ colorScheme: 'light' })
    await openSettings(page, 'zh')
    const initialDialog = page.getByRole('dialog', { name: '设置' })
    const darkCube = initialDialog.getByRole('button', { name: '深色' })
    await selectTheme(darkCube, 'dark')
    await expect.poll(() => darkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
      .toContain('preference: dark')
    await page.keyboard.press('Escape')

    // Hold the real application batch so the shell-owned loading page remains observable.
    const pluginPattern = /\/plugins\/\?\?.+\/client\.js,.+\/client\.js&rev=[a-f\d]{12}$/
    let releaseBundles = (): void => {}
    const bundlesReleased = new Promise<void>((resolve) => { releaseBundles = resolve })
    await page.route(pluginPattern, async (route) => {
      await bundlesReleased
      await route.continue()
    })

    const warningStart = tripwire.warnings.length
    let reload: ReturnType<Page['reload']> | undefined
    try {
      reload = page.reload({ waitUntil: 'domcontentloaded' })
      const loading = page.getByText('Loading plugins…', { exact: true })
      await loading.waitFor({ timeout: 10_000 })
      const state = await loading.evaluate((element) => {
        const boot = element.parentElement?.parentElement
        if (boot === undefined || boot === null) throw new Error('loading hint is detached from the boot page')
        return {
          attr: document.body.hasAttribute('data-ds-dark-theme'),
          background: getComputedStyle(boot).backgroundColor,
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
        }
      })
      expect(state).toEqual({
        attr: true,
        background: 'rgb(21, 21, 23)',
        colorScheme: 'dark',
      })
    } finally {
      releaseBundles()
      await reload
      await page.unroute(pluginPattern)
    }

    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await openSettings(page, 'zh')
    const restoredDialog = page.getByRole('dialog', { name: '设置' })
    const systemCube = restoredDialog.getByRole('button', { name: '跟随系统' })
    // The boot palette precedes the settings mirror's saved preference.
    const restoredDarkCube = restoredDialog.getByRole('button', { name: '深色' })
    await expect.poll(() => restoredDarkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await selectTheme(systemCube, 'system')
    await expect.poll(() => systemCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), {
      timeout: 5_000,
    }).toBe(false)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('flips the theme through the Appearance cubes and persists across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-appearance'))
    interface ThemeState {
      attr: boolean
      background: string
      /** Pre-migration localStorage key; the Host-backed world never writes it. */
      legacy: string | null
      themeColor: string | null
      themeColorCount: number
      faviconPaths: string[]
      token: string
    }
    const readState = async (target: Page = page): Promise<ThemeState> => await target.evaluate(() => {
      const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      const computed = getComputedStyle(document.body)
      const icons = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')]
      return {
        faviconPaths: icons.filter(icon => matchMedia(icon.media).matches).map(icon => new URL(icon.href).pathname),
        attr: document.body.hasAttribute('data-ds-dark-theme'),
        background: computed.backgroundColor,
        legacy: localStorage.getItem('dsh.theme'),
        themeColor: metas[0]?.content ?? null,
        themeColorCount: metas.length,
        token: computed.getPropertyValue('--dsw-alias-bg-base').trim(),
      }
    })
    const expectThemeColorSynchronized = (state: ThemeState): void => {
      expect(state.themeColorCount).toBe(1)
      expect(state.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(state.themeColor).toBe(state.background)
    }
    // Pin the OS scheme to light so the default `system` preference resolves
    // light and the dark flip below is unambiguously the gesture's doing.
    await page.emulateMedia({ colorScheme: 'light' })
    const light = await readState()
    expect(light.attr).toBe(false)
    expect(light.faviconPaths).toEqual(['/favicon.svg'])
    expectThemeColorSynchronized(light)

    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    const darkCube = dialog.getByRole('button', { name: '深色' })
    expect(await darkCube.getAttribute('aria-pressed')).toBe('false')
    await selectTheme(darkCube, 'dark')
    // The full cascade: pressed state, Host-backed preference, body attribute,
    // alias token flip — all from one real user gesture.
    await expect.poll(() => darkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    const dark = await readState()
    expect(dark.attr).toBe(true)
    expect(dark.faviconPaths).toEqual(['/favicon.svg'])
    expect(dark.legacy).toBeNull()
    expect(dark.token).not.toBe(light.token)
    expectThemeColorSynchronized(dark)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
      .toContain('preference: dark')
    await page.keyboard.press('Escape')

    // Reload: the preference survives the background Host read + presenter update.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(true)
    const reloaded = await readState()
    expect(reloaded.legacy).toBeNull()
    expect(reloaded.faviconPaths).toEqual(['/favicon.svg'])
    expectThemeColorSynchronized(reloaded)

    // A second live Host binds another ephemeral port but shares the same
    // user-settings home. Its fresh origin has no theme localStorage and still
    // converges to dark before the settings dialog opens.
    const second = await launchWebScaffold({ developerTools: false, harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.emulateMedia({ colorScheme: 'light' })
      await secondPage.goto(second.authenticatedUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(async () => (await readState(secondPage)).attr, { timeout: 5_000 }).toBe(true)
      const secondState = await readState(secondPage)
      expect(secondState.legacy).toBeNull()
      expectThemeColorSynchronized(secondState)
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    // `system` follows the emulated OS scheme (dark stays dark, light clears).
    await openSettings(page, 'zh')
    const systemCube = page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '跟随系统' })
    await selectTheme(systemCube, 'system')
    await expect.poll(() => systemCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(false)
    expectThemeColorSynchronized(await readState())
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(true)
    await expect.poll(async () => (await readState()).faviconPaths).toEqual(['/favicon-dark.svg'])
    expectThemeColorSynchronized(await readState())
    // Restore for the specs that follow: light preference beats the emulated
    // dark OS scheme, leaving the shared page in the light default.
    await selectTheme(page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '浅色' }), 'light')
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(false)
    expect((await readState()).faviconPaths).toEqual(['/favicon-dark.svg'])
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(async () => (await readState()).faviconPaths).toEqual(['/favicon.svg'])
    expectThemeColorSynchronized(await readState())
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('steps the content font size, applies it to body, and persists across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-font-size'))
    onTestFinished(async () => {
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'hidden' })
    })
    const readFontSize = async (target: Page = page): Promise<string> => await target.evaluate(
      () => document.body.style.getPropertyValue('--dsh-content-font-size'),
    )
    // The secondary tier resolved by the real engine: a probe element's
    // font-size forces min/max/calc evaluation, which the CSS-text specs
    // cannot exercise. Setting −1 at ≤14, setting −2 above.
    const readSecondaryFontSize = async (): Promise<string> => await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.fontSize = 'var(--dsh-content-font-size-secondary, 13px)'
      document.body.appendChild(probe)
      const size = getComputedStyle(probe).fontSize
      probe.remove()
      return size
    })
    // The displayed value is optimistic; wait for the write before the next step.
    const stepFontSize = async (button: Locator, px: number): Promise<void> => {
      const [response] = await Promise.all([
        page.waitForResponse((reply) => {
          if (new URL(reply.url()).pathname !== '/api/settings/mutate' || reply.request().method() !== 'POST') return false
          const request = reply.request().postDataJSON() as { payload: { args: { ns: string } } }
          return request.payload.args.ns === 'ui-theme'
        }),
        button.click(),
      ])
      expect(await response.finished()).toBeNull()
      const envelope = await response.json() as { result: { ok: boolean } }
      expect(envelope.result.ok).toBe(true)
      await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
        .toContain(`fontSize: ${px}`)
      await page.getByRole('dialog', { name: '设置' }).getByText(String(px), { exact: true }).waitFor({ timeout: 5_000 })
      await expect.poll(readFontSize, { timeout: 5_000 }).toBe(`${px}px`)
    }
    expect(await readFontSize()).toBe('14px')
    expect(await readSecondaryFontSize()).toBe('13px')
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    // The stepper reveals its arrows on hover; the up arrow steps 14 → 15 → 16.
    await dialog.getByText('14', { exact: true }).hover()
    const increase = dialog.getByRole('button', { name: '增大字号' })
    await stepFontSize(increase, 15)
    // 15 is the piecewise boundary: the secondary tier holds at 13px (−2)
    // where the ≤14 branch would have given 14px (−1).
    await expect.poll(readSecondaryFontSize, { timeout: 5_000 }).toBe('13px')
    await stepFontSize(increase, 16)
    await expect.poll(readSecondaryFontSize, { timeout: 5_000 }).toBe('14px')
    await page.keyboard.press('Escape')

    // Reload: the boot script embeds the durable size and ThemeRuntime seeds
    // its initial snapshot from the boot-written body variable, so activation
    // never flashes the default while the settings read is in flight.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(readFontSize, { timeout: 5_000 }).toBe('16px')
    expect(await readSecondaryFontSize()).toBe('14px')

    // Restore the default for the specs that follow (and the dialog golden).
    await openSettings(page, 'zh')
    const restored = page.getByRole('dialog', { name: '设置' })
    await restored.waitFor({ timeout: 10_000 })
    await restored.getByText('16', { exact: true }).hover()
    const decrease = restored.getByRole('button', { name: '减小字号' })
    await stepFontSize(decrease, 15)
    await stepFontSize(decrease, 14)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.each([
    ['compact', '简洁'], ['detailed', '详细'], ['verbose', '完全展开'],
  ] as const)('persists the %s work-details mode across reload', async (mode, label) => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-transcript-view'))
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByText('工作步骤展示', { exact: true }).waitFor({ timeout: 10_000 })
    const details = dialog.getByText('工作步骤展示', { exact: true }).locator('../..')
    await details.getByRole('button', { name: '标准', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    await details.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
      .toContain(`transcriptView: ${mode}`)
    await page.keyboard.press('Escape')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await openSettings(page, 'zh')
    const reloaded = page.getByRole('dialog', { name: '设置' })
    const restoredDetails = reloaded.getByText('工作步骤展示', { exact: true }).locator('../..')
    await restoredDetails.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 10_000 })

    await restoredDetails.getByRole('button', { name: label, exact: true }).click()
    await page.getByRole('menuitem', { name: '标准', exact: true }).click()
    await restoredDetails.getByRole('button', { name: '标准', exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
      .toContain('transcriptView: standard')
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('persists the busy-state Enter behavior across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-enter-behavior'))
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '排队发送' }).click()
    await page.getByRole('menuitem', { name: '插话发送' }).click()
    await dialog.getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
      .toContain('busyEnter: steer')
    await page.keyboard.press('Escape')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await openSettings(page, 'zh')
    const reloaded = page.getByRole('dialog', { name: '设置' })
    await reloaded.getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })

    const second = await launchWebScaffold({ developerTools: false, harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.goto(second.authenticatedUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await openSettings(secondPage, 'zh')
      await secondPage.getByRole('dialog', { name: '设置' })
        .getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })
      expect(await secondPage.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    await reloaded.getByRole('button', { name: '插话发送' }).click()
    await page.getByRole('menuitem', { name: '排队发送' }).click()
    await reloaded.getByRole('button', { name: '排队发送' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
      .toContain('busyEnter: queue')
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('persists the settings language across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-language'))
    await openSettings(page, 'zh')
    const zhDialog = page.getByRole('dialog', { name: '设置' })
    await zhDialog.waitFor({ timeout: 10_000 })
    // The document language follows the active locale in the assembled app, not
    // only on a directly-mounted plugin. This is a zh browser, so the served
    // markup's `en` must already have been replaced — asserting it here (rather
    // than only in an English scenario) is what makes the check discriminating.
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN')
    // The Language selector pill shows the active locale's own name.
    const selector = zhDialog.getByRole('button', { name: '中文' })
    expect(await selector.getAttribute('aria-haspopup')).toBe('menu')
    await selector.click()
    await page.getByRole('menuitem', { name: 'English' }).click()
    // The settings-owned copy re-registers localized: dialog title, nav,
    // Appearance labels. (Only the settings namespaces are localized —
    // the rest of the app's copy is intentionally out of this row's scope.)
    const enDialog = page.getByRole('dialog', { name: 'Settings' })
    await enDialog.waitFor({ timeout: 10_000 })
    // ...and the attribute follows that switch, in the assembled app.
    await expect.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 5_000 }).toBe('en')
    expect(await enDialog.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    await enDialog.getByText(`Current version: ${version}`, { exact: true }).waitFor()
    await expect.poll(() => enDialog.getByText('Appearance', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    expect(await page.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
      .toContain('preference: en')
    // Reload keeps English; then restore zh so shared page state (and the
    // other specs' 设置-anchored selectors + goldens) see the default again.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    const enTrigger = page.getByRole('button', { name: 'Settings' })
    await enTrigger.waitFor({ timeout: 10_000 })

    // A Chinese browser on another port still receives the explicit English
    // preference from the shared Host settings document.
    const second = await launchWebScaffold({ developerTools: false, harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.goto(second.authenticatedUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await openSettings(secondPage, 'en')
      await secondPage.getByRole('dialog', { name: 'Settings' })
        .getByRole('button', { name: 'English' }).waitFor({ timeout: 10_000 })
      expect(await secondPage.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    await openSettings(page, 'en')
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'English' }).click()
    await page.getByRole('menuitem', { name: '中文' }).click()
    await page.getByRole('dialog', { name: '设置' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'), { timeout: 5_000 })
      .toContain('preference: zh')
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('opens an English browser in English without any stored preference', async () => {
    // A fresh Host home has no locale preference, so its surface follows the
    // browser. English is also FALLBACK_LOCALE, so this scenario alone cannot
    // distinguish detection from the default — the zh scenarios above supply
    // the discriminating half (a Chinese browser must NOT land on the default).
    const fresh = await launchWebScaffold({ developerTools: false })
    const enPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    const enTripwire = watchConsole(enPage)
    onTestFailed(() => saveFailureShot(enPage, 'web-e2e-settings-browser-language'))
    try {
      await enPage.goto(fresh.authenticatedUrl, { waitUntil: 'load' })
      await enPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      expect(await enPage.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
      await openSettings(enPage, 'en')
      const dialog = enPage.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'English' }).waitFor({ timeout: 10_000 })
      // The plugin list resolves shipped preset names through the en
      // dictionaries instead of echoing the preset declarations' Chinese metadata.
      await dialog.getByRole('button', { name: 'Built-in plugins', exact: true }).click()
      const presetSwitcher = dialog.getByRole('button', { name: 'Choose the agent preset to inspect' })
      await presetSwitcher.waitFor({ timeout: 10_000 })
      expect(await presetSwitcher.textContent()).toBe('Standard mode (default)')
      // The plugin manager speaks the en dictionary too: its sidebar entry
      // and the unavailable notice a scaffold without a profile runtime shows.
      await enPage.keyboard.press('Escape')
      await expect.poll(() => enPage.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)
      await enPage.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
      await enPage.getByRole('button', { name: 'Add plugin', exact: true })
        .waitFor({ timeout: 10_000 })
      // This page has no closing inventory spec to sweep its console, so the
      // scenario clears both tripwire channels itself.
      expect(enTripwire.pageErrors).toEqual([])
      expect(enTripwire.warnings).toEqual([])
    } finally {
      await enPage.close()
      await fresh.close()
    }
  }, 90_000)

  it('opens a browser asking for no shipped language in English', async () => {
    // The product default for "no usable signal": a French browser ships
    // neither zh nor en, so resolution falls to FALLBACK_LOCALE (en) rather
    // than to Chinese.
    const fresh = await launchWebScaffold({ developerTools: false })
    const frPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'fr-FR' })
    const frTripwire = watchConsole(frPage)
    onTestFailed(() => saveFailureShot(frPage, 'web-e2e-settings-unshipped-language'))
    try {
      await frPage.goto(fresh.authenticatedUrl, { waitUntil: 'load' })
      await frPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      expect(await frPage.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
      await openSettings(frPage, 'en')
      const dialog = frPage.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'English' }).waitFor({ timeout: 10_000 })
      // A locale-owned nav label proves the dictionaries resolved to en.
      await dialog.getByRole('button', { name: 'Agent presets' }).waitFor({ timeout: 10_000 })
      // The markup already ships `en`, so this alone cannot prove the sync ran
      // — the zh scenario above is the discriminating half. Asserted here too
      // so a future change that resolves en but writes the wrong tag is caught.
      expect(await frPage.evaluate(() => document.documentElement.lang)).toBe('en')
      // Golden of the English fallback dialog — the visible output this change
      // produces. The zh golden above covers the detected-locale surface, so
      // the pair pins both directions of the resolution.
      await dialog.getByText(`Current version: ${version}`, { exact: true }).waitFor()
      const snapshot = await captureStableAria(frPage, '[role="dialog"]', fresh.workspaceCwd, versionCapture)
      await compareOrRefreshGolden(DIALOG_EN_EXPECTED, snapshot, MODE)
      expect(frTripwire.pageErrors).toEqual([])
      expect(frTripwire.warnings).toEqual([])
    } finally {
      await frPage.close()
      await fresh.close()
    }
  }, 90_000)

  it('hides link-opening settings when the built-in browser is disabled', async () => {
    const fresh = await launchWebScaffold({
      developerTools: false,
      extraOverlayPath: fileURLToPath(new URL('./no-sidebar-browser.overlay.yml', import.meta.url)),
    })
    onTestFinished(() => fresh.close())
    const withoutBrowser = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    onTestFinished(() => withoutBrowser.close())
    const browserConsole = watchConsole(withoutBrowser)
    await withoutBrowser.goto(fresh.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(withoutBrowser, 'en')
    const dialog = withoutBrowser.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Detailed', exact: true }).waitFor()
    expect(await dialog.getByText('Open chat links in', { exact: true }).count()).toBe(0)
    const snapshot = await captureStableAria(withoutBrowser, '[role="dialog"]', fresh.workspaceCwd, versionCapture)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'dialog-no-browser.expected.md'), snapshot, MODE)
    expect(browserConsole.pageErrors).toEqual([])
    expect(browserConsole.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'dialog-en.expected.md',
      'dialog-no-browser.expected.md',
      'dialog.expected.md',
      'plugin-instances.expected.md',
      'plugins.expected.md',
    ])
  })
})
