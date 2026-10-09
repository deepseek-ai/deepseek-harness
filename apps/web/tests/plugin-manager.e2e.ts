// Web e2e scenario: the plugin manager page behind the sidebar's Plugins entry over a
// managed scaffold profile: installed bundles, their rows, and bundle enablement. Zero
// model calls: everything is client state, seeded Session state, profile files, and the settings
// document, so there is no fixture and a stray stream would fail loud on the open llm seam.
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { FiberState } from '@deepseek-ai/cordis'
import { ON_DEMAND_BUNDLES, OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { join } from 'node:path'
import {
  SCAFFOLD_DEFAULTS_BUNDLE, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, openSettings, PLUGIN_TOGGLE_SETTLE_MS, saveFailureShot,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/plugin-manager', import.meta.url))
const MANAGER_EXPECTED = join(SNAPSHOT_DIR, 'manager.expected.md')
const LIVE_EXPECTED = join(SNAPSHOT_DIR, 'live-enabled.expected.md')
const EXPORTS_EXPECTED = join(SNAPSHOT_DIR, 'exports.expected.md')
const EXPORTS_EN_EXPECTED = join(SNAPSHOT_DIR, 'exports-en.expected.md')
const FIXTURE_PLUGINS = fileURLToPath(new URL('./fixtures/plugins', import.meta.url))
const MODE = webSnapshotMode()
/** The profile manifest's bundles as the scaffold initializes them. */
const SCAFFOLD_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', SCAFFOLD_DEFAULTS_BUNDLE]

describe('web e2e: plugin manager', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      profile: { packages: [{ dir: join(FIXTURE_PLUGINS, 'fixture-bundle') }], bundles: ['@fixture/missing-bundle'] },
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

  /** Change the UI language through Settings and close the dialog. */
  async function setLanguage(language: 'en' | 'zh'): Promise<void> {
    if (await page.locator('html').getAttribute('lang') === language) return
    const settings = language === 'en' ? '设置' : 'Settings'
    const source = language === 'en' ? '中文' : 'English'
    const target = language === 'en' ? 'English' : '中文'
    if (await page.getByRole('dialog', { name: settings }).count() === 0) {
      await openSettings(page, language === 'en' ? 'zh' : 'en')
    }
    await page.getByRole('dialog', { name: settings }).getByRole('button', { name: source }).click()
    await page.getByRole('menuitem', { name: target }).click()
    const dialog = page.getByRole('dialog', { name: language === 'en' ? 'Settings' : '设置' })
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count()).toBe(0)
  }

  /** Select the sidebar's Plugins entry and wait for the management page in the main column. */
  async function openPluginsPanel() {
    await closeSettings()
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.waitFor({ timeout: 10_000 })
    while (await panel.getByRole('button', { name: /^返回/ }).count() > 0) {
      await panel.getByRole('button', { name: /^返回/ }).first().click()
    }
    await panel.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 10_000 })
    return panel
  }

  /** One file under the harness home, or the empty string while it does not exist. */
  async function homeFile(...segments: string[]): Promise<string> {
    return readFile(join(scaffold.harnessHome, ...segments), 'utf8').catch(() => '')
  }

  it('aligns the first-read skeleton with the loaded plugin cards', async () => {
    const facts: string[] = []
    let aria = ''
    const shots = MODE === 'refresh' ? await mkdtemp(join(tmpdir(), 'dsh-plugin-loading-')) : undefined
    for (const width of [1680, 1000]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      const release = Promise.withResolvers<undefined>()
      const listBundles = scaffold.ctx.pluginManager.listBundles.bind(scaffold.ctx.pluginManager)
      const reads: ReturnType<typeof listBundles>[] = []
      const spy = vi.spyOn(scaffold.ctx.pluginManager, 'listBundles').mockImplementation(() => {
        const read = release.promise.then(() => listBundles())
        reads.push(read)
        return read
      })
      try {
        const probe = await context.newPage()
        const consoleWatch = watchConsole(probe)
        await probe.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await probe.waitForSelector('[class*="frame"]', { timeout: 30_000 })
        await probe.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
        await expect.poll(() => spy.mock.calls.length, { timeout: 10_000 }).toBeGreaterThan(0)
        const panel = probe.locator('[data-plugin-panel]')
        const skeleton = panel.locator('[data-plugin-loading]')
        await skeleton.waitFor()
        await probe.evaluate(() => document.fonts.ready)
        expect(await skeleton.locator(':scope > ul > li').count()).toBe(4)
        expect(await skeleton.getAttribute('role')).toBe('status')
        expect(await skeleton.getAttribute('aria-label')).toBe('正在读取插件…')
        expect(await panel.getAttribute('aria-busy')).toBe('true')
        const actions = panel.locator(':scope > header > div:last-child button')
        expect(await actions.count()).toBe(3)
        for (const action of await actions.all()) expect(await action.isDisabled()).toBe(true)
        expect(await panel.getByRole('button', { name: '插件说明' }).isEnabled()).toBe(true)
        const loadingAria = await captureStableAria(probe, '[data-plugin-panel]', scaffold.workspaceCwd)
        if (aria === '') aria = loadingAria
        else expect(loadingAria).toBe(aria)

        const measure = (group: Locator, rowSelector = ':scope > ul > li') => group.evaluate((element, selector) => {
          const rect = (node: Element | null | undefined) => {
            if (node === null || node === undefined) throw new Error('Missing plugin layout element')
            const { x, y, width, height } = node.getBoundingClientRect()
            return { x, y, width, height }
          }
          return {
            pageHeader: rect(element.closest('[data-plugin-panel]')?.querySelector(':scope > header')),
            groupHeader: rect(element.firstElementChild),
            rows: Array.from(element.querySelectorAll(selector)).slice(0, 4).map((row) => {
              const head = row.firstElementChild
              const main = head?.children[1]
              return {
                row: rect(row), head: rect(head), icon: rect(head?.children[0]), main: rect(main),
                titleRow: rect(main?.children[0]), title: rect(main?.children[0]?.firstElementChild),
                description: rect(main?.children[1]),
              }
            }),
          }
        }, rowSelector)
        const loading = await measure(skeleton)
        const blankActions = await skeleton.locator(':scope > ul > li > div > div:last-child').evaluateAll(nodes => nodes.map(node => ({
          children: node.childElementCount,
          background: getComputedStyle(node).backgroundColor,
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        })))
        expect(blankActions).toEqual(Array.from({ length: 4 }, () => ({ children: 0, background: 'rgba(0, 0, 0, 0)', width: 36, height: 20 })))
        if (shots !== undefined) {
          for (const colorScheme of ['light', 'dark'] as const) {
            await probe.emulateMedia({ colorScheme })
            const path = join(shots, `loading-${width}-${colorScheme}.png`)
            await panel.screenshot({ path, animations: 'disabled' })
            console.log(`Plugin loading screenshot: ${path}`)
          }
        }
        const motion = await skeleton.evaluate(element => element.getAnimations({ subtree: true }).map(animation => ({
          duration: animation.effect?.getTiming().duration,
          opacityOnly: animation.effect instanceof KeyframeEffect
            && animation.effect.getKeyframes().every(frame => frame.opacity !== undefined && frame.transform === undefined),
        })))
        expect(motion.length).toBe(13)
        expect(motion.every(animation => animation.duration === 2000 && animation.opacityOnly)).toBe(true)
        await probe.emulateMedia({ reducedMotion: 'reduce' })
        await expect.poll(() => skeleton.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0)
        await probe.emulateMedia({ reducedMotion: 'no-preference', colorScheme: null })

        release.resolve(undefined)
        await skeleton.waitFor({ state: 'detached' })
        expect(await panel.getAttribute('aria-busy')).toBe('false')
        for (const action of await actions.all()) expect(await action.isDisabled()).toBe(false)
        const basic = panel.locator('[data-plugin-group="basic"]')
        await basic.locator('[data-plugin-item]').first().waitFor()
        // Configuration cards lead the list; their absent switches give the text column more width.
        const loaded = await measure(basic)
        expect(await basic.locator(':scope > ul > li[data-plugin-item]').count()).toBe(4)
        expect(loaded.rows).toHaveLength(loading.rows.length)
        const compare = (name: string, a: typeof loading.pageHeader, b: typeof loaded.pageHeader, axes: readonly (keyof typeof a)[] = ['x', 'y', 'width', 'height']) => {
          for (const axis of axes) {
            expect(Math.abs(a[axis] - b[axis]), `${width}px ${name}.${axis}: loading=${a[axis]}, loaded=${b[axis]}`).toBeLessThanOrEqual(0.1)
          }
        }
        compare('pageHeader', loading.pageHeader, loaded.pageHeader)
        compare('groupHeader', loading.groupHeader, loaded.groupHeader)
        for (const [index, row] of loading.rows.entries()) {
          const real = loaded.rows[index]
          if (real === undefined) break
          for (const part of ['row', 'head', 'icon'] as const) compare(`row ${index + 1} ${part}`, row[part], real[part])
          // Painted text bars are deliberately shorter than real copy; their line origins and heights align.
          for (const part of ['main', 'titleRow', 'title', 'description'] as const) compare(`row ${index + 1} ${part}`, row[part], real[part], ['x', 'y', 'height'])
        }
        facts.push(`${width}px: ${loaded.rows.length} rows; page/group headers, rows, icons and text line origins align within 0.1px`)
        expect(consoleWatch.pageErrors).toEqual([])
      } finally {
        release.resolve(undefined)
        spy.mockRestore()
        try {
          await context.close()
        } finally {
          await Promise.allSettled(reads)
        }
      }
    }
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'loading.expected.md'), [
      aria, '', ...facts,
      'Loading: header actions disabled; action spaces are empty 36×20 areas, with no switch placeholders',
      'Loaded: skeleton removed; header actions enabled',
      'Motion: 13 opacity-only pulses, 2000ms; reduced motion stops all pulses',
    ].join('\n'), MODE)
  })

  it('delays refresh hints and keeps cards through manual refresh, failure, and retry', async () => {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const listBundles = scaffold.ctx.pluginManager.listBundles.bind(scaffold.ctx.pluginManager)
    const reads: ReturnType<typeof listBundles>[] = []
    try {
      const probe = await context.newPage()
      const consoleWatch = watchConsole(probe)
      onTestFailed(() => saveFailureShot(probe, 'web-e2e-plugin-manager-refresh'))
      await probe.clock.install()
      await probe.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await probe.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = probe.locator('[data-plugin-panel]')
      const refresh = panel.getByRole('button', { name: '刷新', exact: true })
      const add = panel.getByRole('button', { name: '添加插件', exact: true })
      await panel.getByRole('button', { name: '查看 @fixture/bundle', exact: true }).waitFor()
      await expect.poll(() => refresh.isEnabled()).toBe(true)
      await probe.evaluate(() => document.fonts.ready)
      const cards = panel.locator('[data-plugin-package], [data-plugin-item]')
      const cardText = await cards.allTextContents()
      expect(cardText.length).toBeGreaterThan(0)
      const tooltip = probe.getByRole('tooltip').filter({ hasText: '刷新' })
      const trace: string[] = []
      const recordRefresh = async (phase: string) => {
        trace.push(phase, await refresh.ariaSnapshot(), JSON.stringify({
          busy: await panel.getAttribute('aria-busy'),
          spinners: await refresh.locator('[data-state="ongoing"]').count(),
          cards: await cards.count(),
          skeletons: await panel.locator('[data-plugin-loading]').count(),
          alerts: await panel.getByRole('alert').allTextContents(),
          retry: await panel.getByRole('button', { name: '重试', exact: true }).count(),
          toasts: await probe.locator('body > [role="alert"]').allTextContents(),
        }))
      }
      const bounds = await refresh.boundingBox()
      if (bounds === null) throw new Error('Refresh button has no visible bounds')
      await probe.clock.pauseAt(await probe.evaluate(() => Date.now() + 1000))
      try {
        await probe.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        await probe.clock.runFor(499)
        expect(await tooltip.count()).toBe(0)
        trace.push(`Hover at 499ms: ${await tooltip.count()} tooltips`)
        await probe.clock.runFor(1)
        await tooltip.waitFor()
        trace.push('Hover at 500ms:', await tooltip.ariaSnapshot())
        await probe.mouse.move(0, 999)
        await tooltip.waitFor({ state: 'detached' })

        await add.focus()
        await probe.keyboard.press('Shift+Tab')
        expect(await refresh.evaluate(element => element === document.activeElement)).toBe(true)
        await probe.clock.runFor(499)
        expect(await tooltip.count()).toBe(0)
        trace.push(`Focus at 499ms: ${await tooltip.count()} tooltips`)
        await probe.clock.runFor(1)
        await tooltip.waitFor()
        trace.push('Focus at 500ms:', await tooltip.ariaSnapshot())
        await probe.keyboard.press('Tab')
        await tooltip.waitFor({ state: 'detached' })
      } finally {
        await probe.clock.resume()
      }

      await probe.clock.pauseAt(await probe.evaluate(() => Date.now() + 1000))
      const spy = vi.spyOn(scaffold.ctx.pluginManager, 'listBundles')
      try {
        {
          // One failure round exercises the full path: kept cards and spinner while pending,
          // then the failure toast with no inline error over the stale cards. Success and retry
          // outcomes are the store's deterministic concern, covered by manager-store.client.spec.ts.
          const outcome = 'failure' as const
          const release = Promise.withResolvers<undefined>()
          const called = spy.mock.calls.length
          spy.mockImplementationOnce(() => {
            const read = release.promise.then(() => { throw new Error('Fixture plugin refresh failed') })
            reads.push(read)
            return read
          })
          try {
            await refresh.click()
            await expect.poll(() => spy.mock.calls.length).toBeGreaterThan(called)
            expect(await refresh.isDisabled()).toBe(true)
            expect(await refresh.getAttribute('aria-busy')).toBe('true')
            expect(await panel.getAttribute('aria-busy')).toBe('true')
            const spinner = refresh.locator('[data-state="ongoing"]')
            await spinner.waitFor()
            expect(await spinner.evaluate(element => element.getAnimations({ subtree: true }).length)).toBeGreaterThan(0)
            expect(await cards.allTextContents()).toEqual(cardText)
            expect(await panel.locator('[data-plugin-loading]').count()).toBe(0)
            expect(await tooltip.count()).toBe(0)
            expect(await panel.getByRole('alert').count()).toBe(0)
            expect(await probe.locator('body > [role="alert"]').count()).toBe(0)
            await recordRefresh(`${outcome}: pending`)

            release.resolve(undefined)
            await probe.clock.runFor(400)
            await expect.poll(() => refresh.isEnabled()).toBe(true)
            expect(await refresh.getAttribute('aria-busy')).toBe('false')
            expect(await panel.getAttribute('aria-busy')).toBe('false')
            expect(await spinner.count()).toBe(0)
            expect(await cards.allTextContents()).toEqual(cardText)
            expect(await panel.locator('[data-plugin-loading]').count()).toBe(0)
            expect(await panel.getByRole('alert').count()).toBe(0)
            expect(await panel.getByRole('button', { name: '重试', exact: true }).count()).toBe(0)
            const toasts = probe.locator('body > [role="alert"]')
            await expect.poll(() => toasts.allTextContents()).toEqual(['刷新失败，请重试'])
            await recordRefresh(`${outcome}: settled`)
          } finally {
            release.resolve(undefined)
          }
        }
      } finally {
        spy.mockRestore()
        await probe.clock.resume()
      }
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'refresh.expected.md'), trace.join('\n'), MODE)
      expect(consoleWatch.pageErrors).toEqual([])
      expect(consoleWatch.warnings).toEqual([])
    } finally {
      try {
        await context.close()
      } finally {
        await Promise.allSettled(reads)
      }
    }
  })

  it('starts with an unavailable selected bundle and lets the user clear its error', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-missing-bundle'))
    const panel = await openPluginsPanel()
    await panel.getByRole('button', { name: '查看 @fixture/missing-bundle', exact: true }).click()
    const toggle = panel.getByRole('switch', { name: '启用 @fixture/missing-bundle', exact: true })
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    expect(await toggle.isDisabled()).toBe(false)
    await panel.getByText(/cannot resolve profile bundle/).waitFor({ timeout: 10_000 })
    expect((await scaffold.ctx.pluginManager.listBundles()).find(row => row.name === '@fixture/missing-bundle'))
      .toMatchObject({ enabled: true, installed: false, removable: true, error: { code: 'operation-error' }, rows: [] })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'missing-bundle.expected.md'),
      await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd, {
        replacements: [[scaffold.harnessHome, '{{home}}']],
      }), MODE)
    await toggle.click()
    await expect.poll(async () => (JSON.parse(await homeFile('profiles', 'scaffold', 'package.json')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles, { timeout: 10_000 }).toEqual(SCAFFOLD_BUNDLES)
    await expect.poll(() => panel.getByText(/cannot resolve profile bundle/).count(), { timeout: 10_000 }).toBe(0)
    expect((await scaffold.ctx.pluginManager.listBundles()).some(row => row.name === '@fixture/missing-bundle')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('lists the installed bundles with their switches and leaves the installation\'s own to Settings', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-list'))
    const panel = await openPluginsPanel()

    const info = panel.getByRole('button', { name: '插件说明' })
    const infoBounds = await info.boundingBox()
    const iconBounds = await info.locator('svg').boundingBox()
    const subtitleBounds = await panel.getByText('安装、启用和配置插件', { exact: true }).boundingBox()
    if (infoBounds === null || iconBounds === null || subtitleBounds === null) {
      throw new Error('Plugin information button, icon, and subtitle must be visible')
    }
    expect(infoBounds.width).toBe(20)
    expect(infoBounds.height).toBe(20)
    expect(iconBounds.width).toBe(11)
    expect(iconBounds.height).toBe(11)
    expect(infoBounds.x - subtitleBounds.x - subtitleBounds.width).toBeCloseTo(4)
    expect(iconBounds.y + iconBounds.height / 2).toBeCloseTo(subtitleBounds.y + subtitleBounds.height / 2)
    await info.hover()
    const hoverHelp = page.getByRole('tooltip')
    await hoverHelp.waitFor()
    expect(await hoverHelp.textContent()).toBe('在这里配置官方插件，安装和管理其他插件。内置插件列表及运行状态可在「设置 → 内置插件」中查看')
    await panel.getByRole('heading', { name: '插件', exact: true }).hover()
    await hoverHelp.waitFor({ state: 'hidden' })
    await info.focus()
    await page.keyboard.press('Enter')
    const help = page.getByRole('tooltip')
    await help.waitFor()
    expect(await help.textContent()).toContain('设置 → 内置插件')
    await page.keyboard.press('Escape')
    expect(await help.count()).toBe(0)
    expect(await info.evaluate(element => element === document.activeElement)).toBe(true)
    await info.click()
    await panel.getByRole('heading', { name: '插件', exact: true }).hover()
    await help.hover()
    expect(await help.isVisible()).toBe(true)
    await panel.getByRole('heading', { name: '插件', exact: true }).click()
    expect(await help.count()).toBe(0)

    await panel.getByRole('button', { name: '查看 @fixture/bundle', exact: true }).waitFor({ timeout: 20_000 })
    const toggle = panel.getByRole('switch', { name: '启用 @fixture/bundle' })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    const card = panel.locator('[data-plugin-package="@fixture/bundle"]')
    const open = card.getByRole('button', { name: '查看 @fixture/bundle', exact: true })
    await open.hover()
    const hoverRadius = await card.evaluate(element => getComputedStyle(element).borderRadius)
    await toggle.focus()
    await page.keyboard.press('Shift+Tab')
    expect(await open.evaluate(element => element.matches(':focus-visible'))).toBe(true)
    const focusRing = await open.evaluate((element) => {
      const style = getComputedStyle(element, '::after')
      return {
        radius: style.borderRadius,
        cardRadius: style.getPropertyValue('--dsw-radius-xl').trim(),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      }
    })
    expect(focusRing.radius).toBe(hoverRadius)
    expect(focusRing.radius).toBe(focusRing.cardRadius)
    expect(focusRing.outlineStyle).toBe('solid')
    expect(focusRing.outlineWidth).toBeGreaterThan(0)
    // Profile bundles stay in Installed; configuration pages and offered bundles have their own groups.
    expect(await panel.locator('[data-plugin-group="bundles"] [data-plugin-package]').count()).toBe(2)
    expect(await panel.locator('[data-plugin-group="basic"] [data-plugin-item]').count()).toBe(4)
    expect(await panel.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-inspector"]').count()).toBe(0)
    expect(await panel.getByRole('switch', { name: '启用 语音输入', exact: true }).getAttribute('aria-checked')).toBe('false')
    expect(await panel.getByRole('switch', { name: '启用 开发者工具', exact: true }).getAttribute('aria-checked')).toBe('false')
    expect(await panel.getByText('查看调试会话原始数据、聊天消息分组数据，以及调试 NodeJS 后端', { exact: true }).count()).toBe(1)
    expect(await panel.getByText(/Cordis|Chrome DevTools/).count()).toBe(0)
    await panel.getByRole('button', { name: '更多', exact: true }).click()
    await panel.getByRole('heading', { name: '实验性插件', exact: true, level: 1 }).waitFor()
    expect(await panel.locator('[data-plugin-group="more"] [data-plugin-package]').count())
      .toBe(OPTIONAL_BUNDLES.length + ON_DEMAND_BUNDLES.length)
    expect(await panel.getByText('实验性', { exact: true }).count())
      .toBe(OPTIONAL_BUNDLES.filter(name => name.startsWith('@deepseek-ai/dsh-experimental-')).length)
    expect(await panel.locator('[data-plugin-group="bundles"]').count()).toBe(0)
    await panel.getByRole('button', { name: '返回插件', exact: true }).click()
    expect(await panel.locator('[data-plugin-group="bundles"] [data-plugin-package]').count()).toBe(2)
    // A bundle that is off still shows the rows its patch declares, without switches.
    await panel.getByRole('button', { name: '查看 @fixture/bundle' }).click()
    await panel.locator('[data-plugin-row]', { hasText: 'fixture-row' }).waitFor({ timeout: 10_000 })
    expect(await panel.getByRole('switch', { name: '启用组件 @fixture/bundle' }).count()).toBe(0)
    await panel.getByRole('button', { name: '卸载 @fixture/bundle' }).waitFor({ timeout: 5_000 })
    await panel.getByRole('button', { name: '返回插件' }).click()
    await expect.poll(() => panel.getByRole('button', { name: '卸载 @fixture/bundle' }).count(), { timeout: 5_000 }).toBe(0)

    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MANAGER_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps off-state switch thumbs light in both themes', async () => {
    // The off-state thumb must stay light so an operable toggle cannot read as
    // disabled, whose only other difference is reduced opacity.
    for (const [theme, label] of [['light', '浅色'], ['dark', '深色']] as const) {
      await openSettings(page, 'zh')
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('button', { name: '通用设置', exact: true }).click()
      await settings.getByRole('button', { name: label, exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(theme === 'dark')
      const panel = await openPluginsPanel()
      const toggle = panel.getByRole('switch', { name: '启用 @fixture/bundle', exact: true })
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      const appearance = await toggle.evaluate((element) => {
        const thumb = element.firstElementChild
        if (thumb === null) throw new Error('Switch thumb is missing')
        const bounds = element.getBoundingClientRect()
        return {
          width: bounds.width,
          height: bounds.height,
          thumb: getComputedStyle(thumb).backgroundColor,
          opacity: getComputedStyle(element).opacity,
        }
      })
      expect(appearance).toEqual({
        width: 36,
        height: 20,
        thumb: theme === 'dark' ? 'rgb(173, 178, 184)' : 'rgb(255, 255, 255)',
        opacity: '1',
      })
    }
    // Leave the shared page in the default theme for the tests after this one.
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '通用设置', exact: true }).click()
    await settings.getByRole('button', { name: '浅色', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
    await closeSettings()
  })

  it('prefers manifest icons for packages and reads exported icons for subpath plugins', async () => {
    const panel = await openPluginsPanel()
    onTestFinished(closeSettings)
    const fixtureIcon = `data:image/svg+xml;base64,${(await readFile(join(FIXTURE_PLUGINS, 'fixture-bundle/icon.svg'))).toString('base64')}`
    const fallbackIcon = `data:image/svg+xml;base64,${(await readFile(join(FIXTURE_PLUGINS, 'fixture-bundle/fallback-icon.svg'))).toString('base64')}`
    const teamIcon = `data:image/svg+xml;base64,${(await readFile(fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/icon.svg', import.meta.url)))).toString('base64')}`
    const images: string[] = []
    const checkImage = async (selector: string, source: string, label: string) => {
      const image = panel.locator(`${selector} img`).first()
      await image.waitFor()
      expect(await image.getAttribute('src')).toBe(source)
      await image.evaluate(async (node: HTMLImageElement) => { await node.decode() })
      const size = await image.evaluate((node: HTMLImageElement) => ({
        width: node.width, height: node.height, naturalWidth: node.naturalWidth,
      }))
      expect(size.naturalWidth).toBeGreaterThan(0)
      images.push(`${label}: image, ${size.width}×${size.height}, decoded`)
    }
    await checkImage('[data-plugin-package="@fixture/bundle"]', fixtureIcon, 'Third-party bundle card')
    const team = panel.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-agent-team-profile"]')
    expect(await team.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    await checkImage('[data-plugin-package="@deepseek-ai/dsh-experimental-agent-team-profile"]', teamIcon, 'Disabled Agent Teams card')
    try {
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        expect(await team.locator('img').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(36)
        if (MODE === 'refresh') {
          const path = fileURLToPath(new URL(`../../../.artifacts/plugin-icons-${process.pid}-${colorScheme}.png`, import.meta.url))
          await page.screenshot({ path })
          console.log(`Plugin icon screenshot: ${path}`)
        }
      }
    } finally {
      await page.emulateMedia({ colorScheme: null })
    }
    await panel.getByRole('button', { name: '查看 智能体团队', exact: true }).click()
    await checkImage('[data-plugin-detail]', teamIcon, 'Agent Teams detail')
    await panel.getByRole('button', { name: '返回插件' }).click()
    await panel.getByRole('button', { name: '查看 @fixture/bundle', exact: true }).click()
    await checkImage('[data-plugin-detail]', fixtureIcon, 'Third-party bundle detail')
    await checkImage('[data-plugin-row="fixture-search"]', fallbackIcon, 'Independent search row')
    expect(await panel.locator('[data-plugin-row="fixture-review"] img').count()).toBe(0)
    expect(await panel.locator('[data-plugin-row="fixture-review"] svg').count()).toBeGreaterThan(0)
    images.push('Independent review row: generic artwork')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'icons.expected.md'), images.join('\n'), MODE)
    await panel.getByRole('button', { name: '返回插件' }).click()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('localizes independent exports and falls back per field without activating the plugins', async () => {
    onTestFinished(closeSettings)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-exports'))
    const panel = await openPluginsPanel()
    await panel.getByRole('button', { name: '查看 @fixture/bundle' }).click()
    const search = panel.locator('[data-plugin-row]', { hasText: '@fixture/bundle/search' })
    const review = panel.locator('[data-plugin-row]', { hasText: '@fixture/bundle/review' })
    await search.getByText('文件搜索', { exact: true }).waitFor()
    await review.getByText('代码审查', { exact: true }).waitFor()
    expect(await search.getByText('搜索工作区中的文件。', { exact: true }).count()).toBe(1)
    expect(await review.getByText('审查工作区中的改动。', { exact: true }).count()).toBe(1)
    await panel.getByText('Registry description for the fixture bundle.', { exact: true }).first().waitFor()
    expect([...scaffold.ctx.loader.entries()].some(entry => entry.options.name.startsWith('@fixture/bundle'))).toBe(false)
    await compareOrRefreshGolden(EXPORTS_EXPECTED, await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd, {
      replacements: [[FIXTURE_PLUGINS, '{{fixtures}}']],
    }), MODE)
    try {
      await setLanguage('en')
      await search.getByText('File Search', { exact: true }).waitFor()
      expect(await review.getByText('@fixture/bundle/review', { exact: true }).count()).toBeGreaterThan(0)
      expect(await search.getByText('Search package introduction.', { exact: true }).count()).toBe(0)
      expect(await review.getByText('审查工作区中的改动。', { exact: true }).count()).toBe(0)
      await compareOrRefreshGolden(EXPORTS_EN_EXPECTED, await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd, {
        replacements: [[FIXTURE_PLUGINS, '{{fixtures}}']],
      }), MODE)
      expect(await panel.locator('[data-plugin-name]').textContent()).toBe('@fixture/bundle')
    } finally {
      await setLanguage('zh')
    }
    await panel.getByRole('button', { name: '返回插件' }).click()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('updates built-in names and descriptions when the UI language changes', async () => {
    onTestFinished(closeSettings)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-locale'))
    const panel = await openPluginsPanel()
    await panel.getByRole('button', { name: '查看 智能体团队', exact: true }).click()
    const packageName = panel.locator('[data-plugin-name]')
    expect(await packageName.textContent()).toBe('@deepseek-ai/dsh-experimental-agent-team-profile')
    expect(await panel.getByText('启用团队协作、团队工具、成员列表和共享任务看板。').count()).toBe(1)
    const child = panel.locator('[data-plugin-row]', { hasText: 'tool-agent-team' })
    await child.getByText('团队工具', { exact: true }).waitFor()
    expect(await child.getByText('为智能体提供成员协调、消息通信和共享任务管理工具。', { exact: true }).count()).toBe(1)
    try {
      await setLanguage('en')
      await panel.getByRole('heading', { name: 'Agent Teams', exact: true }).waitFor()
      expect(await packageName.textContent()).toBe('@deepseek-ai/dsh-experimental-agent-team-profile')
      expect(await panel.getByText('Enable team collaboration, team tools, the member roster, and the shared task board.').count()).toBe(1)
      await child.getByText('Team Tools', { exact: true }).waitFor()
      expect(await child.getByText('Give agents tools to coordinate members, exchange messages, and manage shared tasks.', { exact: true }).count()).toBe(1)
      await panel.getByRole('button', { name: 'Back to plugins' }).click()
      await panel.getByRole('button', { name: 'View Agent Teams', exact: true }).waitFor()
      expect(await panel.getByRole('switch', { name: 'Enable Agent Teams', exact: true }).count()).toBe(1)
      // Schedule ships in the delivered composition, so no bundle card carries it in either language.
      expect(await panel.getByRole('button', { name: 'View Automation tasks', exact: true }).count()).toBe(0)
      // The official configuration pages follow the language too, from their own dictionary.
      for (const title of ['Shell', 'Agent loop', 'Subagent', 'Web search']) {
        await panel.getByRole('button', { name: `View ${title}`, exact: true }).waitFor()
      }
    } finally {
      await setLanguage('zh')
    }
    await panel.getByRole('button', { name: '查看 智能体团队', exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('enables the Team tools and browser plugin with one bundle switch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-team'))
    const panel = await openPluginsPanel()
    const toggle = panel.getByRole('switch', { name: '启用 智能体团队', exact: true })
    const teamRows = () => [...scaffold.ctx.loader.entries()]
      .filter(entry => ['agent-team', 'tool-agent-team', 'ui-agent-team'].includes(entry.options.id))
    const teamPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const teamTripwire = watchConsole(teamPage)
    try {
      await teamPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspaceZh(teamPage, scaffold.workspaceCwd)
      const agent = scaffold.ctx.agents.list()[0]
      if (agent === undefined) throw new Error('connected Team workspace did not create an Agent')
      // Session actions render only after the conversation leaves its blank state.
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Team UI lifecycle' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await scaffold.ctx.sessions.flush(agent.session)
      // The current crumb renders as plain text inside the zh-labeled hierarchy nav.
      await teamPage.getByRole('navigation', { name: '会话层级' })
        .getByText('Team UI lifecycle', { exact: true }).waitFor()
      const action = teamPage.locator('[data-team-action]')
      expect(await action.count()).toBe(0)
      await toggle.click()
      try {
        await expect.poll(() => teamRows().filter(entry => entry.fiber?.state === FiberState.ACTIVE).length, { timeout: 20_000 }).toBe(3)
        await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
        await action.waitFor({ timeout: 20_000 })
        await action.getByRole('button', { name: '智能体团队', exact: true }).click()
        const teamPanel = teamPage.getByRole('dialog', { name: '智能体团队', exact: true })
        await teamPanel.getByText('Team 暂不可用', { exact: true }).waitFor()
        await teamPage.reload({ waitUntil: 'load' })
        await action.getByRole('button', { name: '智能体团队', exact: true }).click()
        await teamPanel.getByText('暂无共享任务，可以通过对话创建').waitFor()
        await teamPanel.getByText('lead', { exact: true }).waitFor()
        const manifest = JSON.parse(await homeFile('profiles', 'scaffold', 'package.json')) as {
          dsh: { profile: { bundles: string[] } }
        }
        expect(manifest.dsh.profile.bundles).toEqual([...SCAFFOLD_BUNDLES, '@deepseek-ai/dsh-experimental-agent-team-profile'])
        await panel.getByRole('button', { name: '查看 智能体团队', exact: true }).click()
        for (const id of ['agent-team', 'tool-agent-team', 'ui-agent-team']) {
          await panel.locator('[data-plugin-row]', { hasText: id }).first().waitFor()
        }
        await panel.getByRole('button', { name: '返回插件' }).click()
      } finally {
        const back = panel.getByRole('button', { name: '返回插件' })
        if (await back.count() > 0) await back.click()
        if (await toggle.getAttribute('aria-checked') === 'true') await toggle.click()
        await expect.poll(() => teamRows().filter(entry => entry.fiber?.state === FiberState.ACTIVE).length, { timeout: 20_000 }).toBe(0)
        await expect.poll(() => action.count(), { timeout: 20_000 }).toBe(0)
      }
      expect(teamTripwire.pageErrors).toEqual([])
      expect(teamTripwire.warnings).toEqual([])
    } finally {
      await teamPage.close()
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('mounts the delivered Automation tasks rows without a bundle switch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-schedule'))
    const panel = await openPluginsPanel()
    const scheduleRows = () => [...scaffold.ctx.loader.entries()]
      .filter(entry => ['schedule', 'ui-schedule'].includes(entry.options.id))
    // The delivered Web composition ships both rows enabled, so no bundle card
    // offers a switch for them.
    expect(scheduleRows()).toHaveLength(2)
    expect(scheduleRows().every(entry => entry.fiber?.state === FiberState.ACTIVE)).toBe(true)
    expect(await panel.getByRole('button', { name: '查看 自动化任务', exact: true }).count()).toBe(0)
    expect(await panel.getByRole('switch', { name: '启用 自动化任务', exact: true }).count()).toBe(0)
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '自动化任务', exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps IME confirmation Enter in install fields and submits only a plain Enter', async () => {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const manager = scaffold.ctx.pluginManager
    const manifest = await homeFile('profiles', 'scaffold', 'package.json')
    const registrySpy = vi.spyOn(manager, 'registries').mockResolvedValue({
      registry: null, fallbackRegistries: [], resolved: 'https://registry.npmjs.org/',
    })
    const inspectSpy = vi.spyOn(manager, 'inspect').mockImplementation(async (spec, options) => ({
      status: 'accepted', kind: 'registry', name: spec, version: '1.0.0', bundle: true, registry: options?.registry ?? null,
    }))
    const installSpy = vi.spyOn(manager, 'installBundle').mockImplementation(async spec => ({
      changed: false, application: 'failed', stage: 'install', target: spec,
      error: { code: 'operation-error', diagnostic: 'IME fixture: no package was installed' },
    }))
    try {
      const probe = await context.newPage()
      const consoleWatch = watchConsole(probe)
      onTestFailed(() => saveFailureShot(probe, 'web-e2e-plugin-manager-ime-enter'))
      await probe.clock.install()
      await probe.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await probe.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = probe.locator('[data-plugin-panel]')
      await panel.getByRole('button', { name: '查看 @fixture/bundle', exact: true }).waitFor({ timeout: 20_000 })
      const trace: string[] = ['Synthetic browser KeyboardEvents, not an OS input-method test.']
      for (const target of ['package', 'custom registry'] as const) {
        inspectSpy.mockClear()
        installSpy.mockClear()
        await panel.getByRole('button', { name: '添加插件', exact: true }).click()
        const dialog = probe.getByRole('dialog', { name: '添加插件', exact: true })
        await dialog.waitFor({ timeout: 10_000 })
        const spec = target === 'package' ? 'ime-confirm-package' : 'ime-confirm-registry'
        const specField = dialog.getByRole('textbox', { name: '包名或地址', exact: true })
        await specField.fill(spec)
        let field = specField
        const customRegistry = 'https://registry.example.test/'
        if (target === 'custom registry') {
          const registryToggle = dialog.getByRole('button', { name: /^安装源/ })
          await registryToggle.click()
          const registry = probe.locator('[data-install-registry]')
          const offered = registry.getByRole('radio', { name: 'npm 官方源 registry.npmjs.org', exact: true })
          const custom = registry.getByRole('radio', { name: '自定义地址', exact: true })
          field = registry.getByRole('textbox', { name: '自定义地址', exact: true })
          expect(await offered.isChecked()).toBe(true)
          expect(await custom.isChecked()).toBe(false)
          await offered.focus()
          await probe.keyboard.press('Tab')
          expect(await field.evaluate(element => element === document.activeElement)).toBe(true)
          expect(await offered.isChecked()).toBe(true)
          expect(await custom.isChecked()).toBe(false)
          await probe.keyboard.press('Shift+Tab')
          expect(await offered.evaluate(element => element === document.activeElement)).toBe(true)
          await probe.keyboard.press('Shift+Tab')
          await registry.waitFor({ state: 'detached' })
          expect(await registryToggle.evaluate(element => element === document.activeElement)).toBe(true)
          await probe.keyboard.press('Enter')
          await custom.focus()
          await probe.keyboard.press('Space')
          expect(await custom.isChecked()).toBe(true)
          expect(await offered.isChecked()).toBe(false)
          expect(await field.evaluate(element => element === document.activeElement)).toBe(true)
          await field.fill(customRegistry)
          await probe.keyboard.press('Shift+Tab')
          expect(await custom.evaluate(element => element === document.activeElement)).toBe(true)
          await probe.keyboard.press('Tab')
          expect(await field.evaluate(element => element === document.activeElement)).toBe(true)
          await probe.keyboard.press('Tab')
          await registry.waitFor({ state: 'detached' })
          expect(await registryToggle.evaluate(element => element === document.activeElement)).toBe(true)
          await probe.keyboard.press('Enter')
          await custom.focus()
          await probe.keyboard.press('Tab')
          expect(await field.evaluate(element => element === document.activeElement)).toBe(true)
          expect(await custom.isChecked()).toBe(true)
        }
        const value = target === 'package' ? spec : customRegistry
        const assertUnsubmitted = async (label: string) => {
          expect(await field.inputValue()).toBe(value)
          expect(await field.isEditable()).toBe(true)
          expect(await dialog.getByRole('button', { name: '安装', exact: true }).isEnabled()).toBe(true)
          expect(inspectSpy).not.toHaveBeenCalled()
          expect(installSpy).not.toHaveBeenCalled()
          trace.push(`${target} / ${label}: inspect=0, install=0; editable; value retained`, await field.ariaSnapshot())
        }
        await probe.clock.pauseAt(await probe.evaluate(() => Date.now() + 1000))
        try {
          for (const event of [
            { label: 'isComposing=true', isComposing: true, keyCode: 13 },
            { label: 'Safari isComposing=false, keyCode=229', isComposing: false, keyCode: 229 },
          ]) {
            await field.dispatchEvent('keydown', {
              key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
              isComposing: event.isComposing, keyCode: event.keyCode,
            })
            await assertUnsubmitted(event.label)
          }
          const unmarkedEnter = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: false, keyCode: 13 }
          await field.dispatchEvent('compositionstart')
          await field.dispatchEvent('keydown', unmarkedEnter)
          await assertUnsubmitted('compositionstart + unmarked Enter')
          await field.dispatchEvent('compositionend')
          await field.dispatchEvent('keydown', unmarkedEnter)
          await assertUnsubmitted('compositionend + immediate unmarked Enter')
          await probe.clock.runFor(9)
          await field.dispatchEvent('keydown', unmarkedEnter)
          await assertUnsubmitted('compositionend + 9ms unmarked Enter')
          await probe.clock.runFor(2)
        } finally {
          await probe.clock.resume()
        }
        await field.press('Enter')
        await expect.poll(() => inspectSpy.mock.calls.length, { timeout: 10_000 }).toBe(1)
        await expect.poll(() => installSpy.mock.calls.length, { timeout: 10_000 }).toBe(1)
        expect(inspectSpy.mock.calls[0]?.[0]).toBe(spec)
        expect(installSpy.mock.calls[0]?.[0]).toBe(spec)
        expect(installSpy.mock.calls[0]?.[1]).toMatchObject({ enabled: false, registry: target === 'package' ? null : customRegistry })
        const failed = probe.getByRole('dialog', { name: '插件安装失败', exact: true })
        await failed.waitFor({ timeout: 10_000 })
        trace.push(`${target} / plain Enter: inspect=1, install=1`, await failed.ariaSnapshot())
        await failed.getByRole('button', { name: '关闭', exact: true }).click()
        await failed.waitFor({ state: 'hidden', timeout: 10_000 })
      }
      expect(await homeFile('profiles', 'scaffold', 'package.json')).toBe(manifest)
      expect(consoleWatch.pageErrors).toEqual([])
      trace.push('Profile manifest unchanged; controlled Host result performed no package installation.')
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ime-enter.expected.md'), trace.join('\n'), MODE)
    } finally {
      try { await context.close() }
      finally {
        registrySpy.mockRestore()
        inspectSpy.mockRestore()
        installSpy.mockRestore()
      }
    }
  }, 60_000)

  it('checks a spec before installing it and words what the check refused', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-install'))
    const panel = await openPluginsPanel()
    await panel.getByRole('button', { name: '添加插件', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '添加插件' })
    await dialog.waitFor({ timeout: 10_000 })
    const field = dialog.getByRole('textbox', { name: '包名或地址' })
    expect(await page.getByRole('menu').count()).toBe(0)
    await expect.poll(() => field.evaluate(element => document.activeElement === element)).toBe(true)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await panel.getByRole('button', { name: '选择添加插件方式', exact: true }).click()
    const menu = page.getByRole('menu')
    await menu.getByRole('menuitem', { name: /^安装第三方插件/ }).click()
    await menu.waitFor({ state: 'hidden' })
    await dialog.waitFor({ state: 'visible' })
    await expect.poll(() => field.evaluate(element => document.activeElement === element)).toBe(true)
    const install = dialog.getByRole('button', { name: '安装', exact: true })
    expect(await install.isDisabled()).toBe(true)
    expect(await dialog.getByRole('note').textContent()).toContain('请确认插件来源可信')
    expect(await dialog.getByRole('note').textContent()).toContain('按需安装的官方插件会在版本与 DSH 不同时提供“更新”')
    expect(await dialog.getByRole('note').textContent()).toContain('其他插件请先卸载再安装新版')
    await dialog.getByRole('button', { name: '插件安装引导和示例' }).click()
    // The guide carries the package-name example only; the former template strings keep their replacement reminder.
    await expect.poll(() => dialog.getByRole('listitem').count()).toBe(1)
    await dialog.getByRole('button', { name: '填入示例 dsh-plugin-whale-pet' }).click()
    expect(await field.inputValue()).toBe('dsh-plugin-whale-pet')
    expect(await dialog.getByRole('status').count()).toBe(0)
    for (const [example, hint] of [
      ['https://github.com/author/dsh-plugin', '请替换为实际的 Git 仓库地址'],
      ['/Users/name/my-plugin', '请替换为本机插件目录的实际路径'],
    ] as const) {
      await field.fill(example)
      expect(await dialog.getByRole('status').textContent()).toBe(hint)
    }
    await field.fill('/actual/plugin-directory')
    expect(await dialog.getByRole('status').count()).toBe(0)
    await dialog.getByRole('button', { name: '收起引导' }).click()
    expect(await dialog.getByRole('note').textContent()).toContain('请确认插件来源可信')
    // A name the list already shows is refused without asking the Host.
    await field.fill('@fixture/bundle')
    await install.click()
    await dialog.getByRole('alert').waitFor({ timeout: 5_000 })
    expect(await dialog.getByRole('alert').textContent()).toBe('该插件已安装。如需升级，请卸载后重新安装')
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
    const toggle = panel.getByRole('switch', { name: '启用 @fixture/bundle' })
    await toggle.waitFor({ timeout: 20_000 })
    const mounted = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'fixture-row')
    expect(mounted()?.fiber?.state).toBeUndefined()

    await toggle.click()

    const bundles = async () => (JSON.parse(await homeFile('profiles', 'scaffold', 'package.json')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles
    await expect.poll(bundles, { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toEqual([...SCAFFOLD_BUNDLES, '@fixture/bundle'])
    // A live profile: the row mounts once the whole tree recomposed, the switch is on, and nothing waits for a restart.
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).toBe(2)
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
    expect(await panel.getByText(/下次启动生效/).count()).toBe(0)
    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(LIVE_EXPECTED, snapshot, MODE)
    // The pack's page lists its rows as the Host runs them, each with a switch that writes the profile patch.
    await panel.getByRole('button', { name: '查看 @fixture/bundle' }).click()
    const rowSwitch = panel.getByRole('switch', { name: '启用组件 @fixture/bundle' })
    await rowSwitch.waitFor({ timeout: 10_000 })
    expect(await rowSwitch.getAttribute('aria-checked')).toBe('true')
    await rowSwitch.click()
    await expect.poll(async () => (await homeFile('profiles', 'scaffold', 'cordis.patch.yml')).includes('fixture-row'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe(true)
    await expect.poll(() => rowSwitch.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
    // A disabled entry keeps its disposed fiber; only an active one counts as mounted.
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).not.toBe(2)
    await rowSwitch.click()
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).toBe(2)
    await panel.getByRole('button', { name: '返回插件' }).click()

    await toggle.click()
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).not.toBe(2)
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'manager.expected.md', 'live-enabled.expected.md', 'missing-bundle.expected.md', 'exports.expected.md', 'exports-en.expected.md', 'icons.expected.md', 'loading.expected.md', 'refresh.expected.md',
      'ime-enter.expected.md',
    ])
  })
})


describe('web e2e: startup-applied plugin management', () => {
  it('saves a bundle selection that waits for the next start and keeps its rows read-only', async () => {
    const scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
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
      const toggle = panel.getByRole('switch', { name: '启用 @fixture/bundle' })
      await toggle.waitFor({ timeout: 20_000 })
      const mounted = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'fixture-row')
      const bundles = async () => {
        const text = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'package.json'), 'utf8')
        return (JSON.parse(text) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
      }
      expect(mounted()?.fiber?.state).toBeUndefined()
      await toggle.click()
      // The selection is saved and the switch turns on, but nothing mounts before the next start; a toast says so.
      await expect.poll(bundles, { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toEqual([...SCAFFOLD_BUNDLES, '@fixture/bundle'])
      await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
      await page.getByText('更改将在下次启动生效', { exact: true }).waitFor({ timeout: 10_000 })
      expect(mounted()?.fiber?.state).toBeUndefined()
      // The pack's page lists its rows from their declarations, with no live entry to switch.
      await panel.getByRole('button', { name: '查看 @fixture/bundle' }).click()
      await panel.locator('[data-plugin-row]', { hasText: 'fixture-row' }).waitFor({ timeout: 10_000 })
      expect(await panel.getByRole('switch', { name: '启用组件 @fixture/bundle' }).isDisabled()).toBe(true)
      await panel.getByRole('button', { name: '返回插件' }).click()

      await toggle.click()
      await expect.poll(bundles, { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toEqual(SCAFFOLD_BUNDLES)
      await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await browser?.close()
      await scaffold.close()
    }
  }, 60_000)
})
