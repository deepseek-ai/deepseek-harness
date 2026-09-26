// Web e2e scenario: the plugin manager page behind the sidebar's Plugins entry over a
// managed scaffold profile: installed bundles, their rows, and bundle enablement. Zero
// model calls: everything is client state, seeded Session state, profile files, and the settings
// document, so there is no fixture and a stray stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { FiberState } from '@deepseek-ai/cordis'
import { OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  SCAFFOLD_DEFAULTS_BUNDLE, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, openSettings, saveFailureShot } from './support.ts'

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

  it('starts with an unavailable selected bundle and lets the user clear its error', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-missing-bundle'))
    const panel = await openPluginsPanel()
    await panel.getByRole('button', { name: '查看 @fixture/missing-bundle', exact: true }).click()
    const toggle = panel.getByRole('switch', { name: '启用 @fixture/missing-bundle', exact: true })
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    expect(await toggle.isDisabled()).toBe(false)
    await panel.getByText(/cannot resolve profile bundle/).waitFor({ timeout: 10_000 })
    expect((await scaffold.ctx.pluginManager.listBundles()).find(row => row.name === '@fixture/missing-bundle'))
      .toMatchObject({ enabled: true, error: { code: 'operation-error' }, rows: [] })
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

    await panel.getByRole('button', { name: '查看 @fixture/bundle', exact: true }).waitFor({ timeout: 20_000 })
    const toggle = panel.getByRole('switch', { name: '启用 @fixture/bundle' })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    // The profile's own group holds its fixture bundle and the scaffold's defaults bundle; the installation's
    // optional bundles open the Official group, followed by the official plugins that registered their
    // configuration, and its other bundles stay off the page.
    expect(await panel.locator('[data-plugin-group="bundles"] [data-plugin-package]').count()).toBe(2)
    expect(await panel.locator('[data-plugin-group="official"] [data-plugin-package]').count()).toBe(OPTIONAL_BUNDLES.length)
    expect(await panel.locator('[data-plugin-group="official"] [data-plugin-item]').count()).toBe(4)
    expect(await panel.getByText('实验性', { exact: true }).count())
      .toBe(OPTIONAL_BUNDLES.filter(name => name.startsWith('@deepseek-ai/dsh-experimental-')).length)
    expect(await panel.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-inspector"]').count()).toBe(0)
    expect(await panel.getByRole('switch', { name: '启用 语音输入', exact: true }).getAttribute('aria-checked')).toBe('false')
    // A bundle that is off still shows the rows its patch declares, without switches.
    await panel.getByRole('button', { name: '查看 @fixture/bundle' }).click()
    await panel.locator('[data-plugin-row]', { hasText: 'fixture-row' }).waitFor({ timeout: 10_000 })
    expect(await panel.getByRole('switch', { name: '启用组件 @fixture/bundle' }).count()).toBe(0)
    await panel.getByRole('button', { name: '卸载 @fixture/bundle' }).waitFor({ timeout: 5_000 })
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    await expect.poll(() => panel.getByRole('button', { name: '卸载 @fixture/bundle' }).count(), { timeout: 5_000 }).toBe(0)

    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MANAGER_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('decodes manifest icons for disabled bundles and independent plugin rows', async () => {
    const panel = await openPluginsPanel()
    const fixtureIcon = `data:image/svg+xml;base64,${(await readFile(join(FIXTURE_PLUGINS, 'fixture-bundle/icon.svg'))).toString('base64')}`
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
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    await panel.getByRole('button', { name: '查看 @fixture/bundle', exact: true }).click()
    await checkImage('[data-plugin-detail]', fixtureIcon, 'Third-party bundle detail')
    await checkImage('[data-plugin-row="fixture-search"]', fixtureIcon, 'Independent search row')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'icons.expected.md'), images.join('\n'), MODE)
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('localizes independent exports and falls back per field without activating the plugins', async () => {
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
    await compareOrRefreshGolden(EXPORTS_EXPECTED, await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd), MODE)
    try {
      await setLanguage('en')
      await search.getByText('File Search', { exact: true }).waitFor()
      expect(await review.getByText('@fixture/bundle/review', { exact: true }).count()).toBeGreaterThan(0)
      expect(await search.getByText('Search package introduction.', { exact: true }).count()).toBe(1)
      expect(await review.getByText('审查工作区中的改动。', { exact: true }).count()).toBe(0)
      await compareOrRefreshGolden(EXPORTS_EN_EXPECTED, await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd), MODE)
      expect(await panel.locator('[data-plugin-name]').textContent()).toBe('@fixture/bundle')
    } finally {
      await setLanguage('zh')
      await closeSettings()
    }
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('updates built-in names and descriptions when the UI language changes', async () => {
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
      // The official configuration pages follow the language too, from their own dictionary.
      for (const title of ['Shell', 'Agent loop', 'Subagent', 'Web search']) {
        await panel.getByRole('button', { name: `View ${title}`, exact: true }).waitFor()
      }
    } finally {
      await setLanguage('zh')
      await closeSettings()
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
        await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
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
        await panel.getByRole('button', { name: '返回插件列表' }).click()
      } finally {
        const back = panel.getByRole('button', { name: '返回插件列表' })
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
    const toggle = panel.getByRole('switch', { name: '启用 @fixture/bundle' })
    await toggle.waitFor({ timeout: 20_000 })
    const mounted = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'fixture-row')
    expect(mounted()?.fiber?.state).toBeUndefined()

    await toggle.click()

    const bundles = async () => (JSON.parse(await homeFile('profiles', 'scaffold', 'package.json')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles
    await expect.poll(bundles, { timeout: 10_000 }).toEqual([...SCAFFOLD_BUNDLES, '@fixture/bundle'])
    // A live profile: the row mounts once the whole tree recomposed, the switch is on, and nothing waits for a restart.
    await expect.poll(() => mounted()?.fiber?.state, { timeout: 20_000 }).toBe(2)
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true')
    expect(await panel.getByText(/下次启动生效/).count()).toBe(0)
    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(LIVE_EXPECTED, snapshot, MODE)
    // The pack's page lists its rows as the Host runs them, each with a switch that writes the profile patch.
    await panel.getByRole('button', { name: '查看 @fixture/bundle' }).click()
    const rowSwitch = panel.getByRole('switch', { name: '启用组件 @fixture/bundle' })
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
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'manager.expected.md', 'live-enabled.expected.md', 'missing-bundle.expected.md', 'exports.expected.md', 'exports-en.expected.md', 'icons.expected.md',
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
      await expect.poll(bundles).toEqual([...SCAFFOLD_BUNDLES, '@fixture/bundle'])
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await page.getByText('更改将在下次启动生效', { exact: true }).waitFor({ timeout: 10_000 })
      expect(mounted()?.fiber?.state).toBeUndefined()
      // The pack's page lists its rows from their declarations, with no live entry to switch.
      await panel.getByRole('button', { name: '查看 @fixture/bundle' }).click()
      await panel.locator('[data-plugin-row]', { hasText: 'fixture-row' }).waitFor({ timeout: 10_000 })
      expect(await panel.getByRole('switch', { name: '启用组件 @fixture/bundle' }).isDisabled()).toBe(true)
      await panel.getByRole('button', { name: '返回插件列表' }).click()

      await toggle.click()
      await expect.poll(bundles).toEqual(SCAFFOLD_BUNDLES)
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await browser?.close()
      await scaffold.close()
    }
  }, 60_000)
})
