// Web e2e scenario: the configuration pages on the Plugins page — the official
// pages a deployment's exposed host-plane namespaces produce, one field edited
// through the real wire down to `$DSH_HOME/cordis.patch.yml`, the override badge
// and reset that layering produces, and a community bundle's row configuration
// registered by its own browser half. Zero model calls: everything is client
// state plus the settings document and the profile on a blank frame, so there
// is no fixture and a stray stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-app-boot'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/plugin-config', import.meta.url))
const OFFICIAL_EXPECTED = join(SNAPSHOT_DIR, 'official.expected.md')
const ROW_EXPECTED = join(SNAPSHOT_DIR, 'row.expected.md')
const BUNDLE_EXPECTED = join(SNAPSHOT_DIR, 'bundle.expected.md')
const FIXTURE_PLUGINS = fileURLToPath(new URL('./fixtures/plugins', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: plugin configuration pages', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // The live-client fixture is a bundle with a browser half; switched on
    // below, that half registers its row's configuration into the page.
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      profile: { packages: [{ dir: join(FIXTURE_PLUGINS, 'fixture-live-client') }] },
    })
    browser = await chromium.launch()
    // Chinese browser: the pages assert the localized copy the client derives
    // from it, as the rest of the settings surface does.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Show the Plugins page's cards. The scenarios share one page so the
   * settings document accumulates across them, so this closes any settings
   * dialog a previous scenario left open and leaves whatever page it opened.
   */
  async function openPlugins(): Promise<Locator> {
    if (await page.getByRole('dialog', { name: '设置' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    }
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.waitFor({ timeout: 10_000 })
    while (await panel.getByRole('button', { name: /^返回/ }).count() > 0) {
      await panel.getByRole('button', { name: /^返回/ }).first().click()
    }
    await panel.getByRole('heading', { name: '官方', exact: true }).waitFor({ timeout: 20_000 })
    return panel
  }

  /** Open one official plugin's page from its card and wait for its form. */
  async function openPage(panel: Locator, title: string): Promise<void> {
    await panel.getByRole('button', { name: `查看 ${title}`, exact: true }).click()
    await panel.locator('[data-plugin-config]').waitFor({ timeout: 10_000 })
  }

  /** The settings document as the Host has written it so far. */
  async function settingsDocument(): Promise<string> {
    return readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8').catch(() => '')
  }

  it('lists one official page per exposed host-plane namespace after the official bundles', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-cards'))
    const panel = await openPlugins()

    // Every page the shipped web composition exposes: the shell executor, the
    // agent loop, subagent selection, and the DeepSeek search provider, after
    // the official bundles the installation ships switched off.
    await panel.getByRole('button', { name: '查看 网页搜索', exact: true }).waitFor({ timeout: 20_000 })
    const official = panel.locator('[data-plugin-group="official"]')
    expect(await official.locator('[data-plugin-package]').count()).toBe(OPTIONAL_BUNDLES.length)
    expect(await official.locator('[data-plugin-item]').count()).toBe(4)
    for (const title of ['终端', 'Agent 循环', '子智能体', '网页搜索']) {
      expect(await official.getByRole('button', { name: `查看 ${title}`, exact: true }).count()).toBe(1)
    }
    // A card carries the one-liner; the fields wait for the page.
    expect(await official.getByText('限制每条命令最多能跑多久、最多输出多少内容。', { exact: true }).count()).toBe(1)
    expect(await panel.getByLabel('命令超时（毫秒）').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(OFFICIAL_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('saves subagent limits and resets them to the deployment defaults', async () => {
    const panel = await openPlugins()
    await openPage(panel, '子智能体')
    const depth = panel.getByLabel('最大递归深度', { exact: true })
    const capacity = panel.getByLabel('子智能体并行数量上限', { exact: true })
    expect(await depth.inputValue()).toBe('1')
    expect(await capacity.inputValue()).toBe('8')
    await depth.fill('2')
    await capacity.fill('12')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => panel.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
    await expect.poll(settingsDocument).toContain('maxActiveSubagents: 12')
    await expect.poll(settingsDocument).toContain('maxDepth: 2')
    await openPlugins()
    await openPage(panel, '子智能体')
    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'subagent.expected.md'), snapshot, MODE)
    const controlHeight = await depth.evaluate(element => element.getBoundingClientRect().height)
    await depth.fill('1.5')
    expect(await depth.evaluate(element => element.getBoundingClientRect().height)).toBe(controlHeight)
    expect(await panel.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
    await depth.fill('2')
    await panel.getByRole('button', { name: '恢复默认', exact: true }).first().click()
    await panel.getByRole('button', { name: '恢复默认', exact: true }).first().click()
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => panel.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
    await openPlugins()
    await openPage(panel, '子智能体')
    expect(await depth.inputValue()).toBe('1')
    expect(await capacity.inputValue()).toBe('8')
    await panel.getByRole('button', { name: '返回插件列表', exact: true }).click()
  })

  it('opens field explanations with the keyboard and retains unsaved edits', async () => {
    const panel = await openPlugins()
    await openPage(panel, '子智能体')
    const depth = panel.getByLabel('最大递归深度', { exact: true })
    await depth.fill('2')
    const depthHelp = panel.getByRole('button', { name: '最大递归深度说明', exact: true })
    expect(await panel.getByRole('region', { name: '最大递归深度说明', exact: true }).count()).toBe(0)
    await depthHelp.press('Enter')
    const depthRules = panel.getByRole('region', { name: '最大递归深度说明', exact: true })
    await depthRules.waitFor()
    expect(await depthRules.getByText('限制 Agent 创建子智能体的递归层级。', { exact: true }).count()).toBe(1)
    const depthTable = depthRules.getByRole('table', { name: '最大递归深度说明', exact: true })
    expect(await depthTable.getByRole('row', { name: '0 禁用子智能体', exact: true }).count()).toBe(1)
    expect(await depthTable.getByRole('row', { name: '1 仅允许主 Agent 创建子智能体', exact: true }).count()).toBe(1)
    expect(await depthRules.getByText('如果某个工具单独设置了最大递归深度，以该工具的设置为准。', { exact: true }).count()).toBe(1)
    await depthHelp.press('Enter')
    expect(await depthRules.count()).toBe(0)
    expect(await depth.inputValue()).toBe('2')
    await panel.getByRole('button', { name: '子智能体并行数量上限说明', exact: true }).click()
    const capacityRules = panel.getByRole('region', { name: '子智能体并行数量上限说明', exact: true })
    expect(await capacityRules.getByText('同一主 Agent 下，所有递归层级同时存活的子智能体总数，主 Agent 不计入。达到上限时，新的启动请求会被拒绝。', { exact: true }).count()).toBe(1)
    await panel.getByRole('button', { name: '返回插件列表', exact: true }).click()
    await openPage(panel, '子智能体')
    expect(await depth.inputValue()).toBe('1')
  })

  it('saves limits and the model allowlist together from the shared card', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-subagent-model-selection'))
    const panel = await openPlugins()
    await openPage(panel, '子智能体')
    const toggle = panel.getByRole('switch', { name: '允许 Agent 为子智能体选择模型' })

    await panel.getByLabel('最大递归深度', { exact: true }).fill('2')
    await toggle.click()
    const models = panel.getByRole('group', { name: 'Agent 可选择的模型' })
    await models.waitFor({ timeout: 10_000 })
    const firstModel = models.getByRole('checkbox').first()
    await firstModel.check()
    const save = panel.getByRole('button', { name: '保存', exact: true })
    await save.click()

    // The Save label returns only after both namespace controllers settle.
    await expect.poll(() => save.isDisabled(), { timeout: 10_000 }).toBe(true)
    const saved = await settingsDocument()
    expect(saved).toContain('id: subagent-model-selection-settings')
    expect(saved).toContain('maxDepth: 2')
    expect(saved).toContain('enabled: true')
    expect(saved).toContain('allowedModels:')
    expect(saved).toContain('provider:')
    expect(saved).toContain('model:')
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('true')

    await toggle.click()
    await save.click()
    await expect.poll(async () => (await settingsDocument()).includes('enabled: false'), { timeout: 10_000 })
      .toBe(true)
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stages an edit and writes it only when saved', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-write'))
    const panel = await openPlugins()
    await openPage(panel, '终端')
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'bash-sandbox')!
    const fiber = entry.fiber

    const timeout = panel.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })
    // The composed default this deployment ships, before any user layer.
    expect(await timeout.inputValue()).toBe('60000')
    await timeout.fill('12000')
    await timeout.blur()

    // Nothing crosses the wire until the user saves: leaving the control is
    // not a decision to store the value.
    expect(await settingsDocument()).not.toContain('timeoutMs')
    const save = panel.getByRole('button', { name: '保存', exact: true })
    await expect.poll(() => save.isEnabled(), { timeout: 5_000 }).toBe(true)
    await save.click()

    await expect.poll(async () => (await settingsDocument()).includes('timeoutMs: 12000'), { timeout: 10_000 })
      .toBe(true)
    expect(scaffold.ctx.shell.resolve({ command: 'true' }).timeoutMs).toBe(12000)
    expect(entry.fiber === fiber).toBe(true)
    // Presence in the user layer is what the badge reports, and the reset is
    // offered only for a field that has one.
    await expect.poll(() => panel.getByText('已覆盖').count(), { timeout: 5_000 }).toBe(1)
    expect(await panel.getByRole('button', { name: '恢复默认' }).count()).toBe(1)
    // A settled form offers no save to repeat.
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('drops a staged edit when the page is left, without touching the document', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-leave'))
    const panel = await openPlugins()
    await openPage(panel, '终端')
    const timeout = panel.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('7000')
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    await panel.getByRole('heading', { name: '官方', exact: true }).waitFor({ timeout: 10_000 })
    await openPage(panel, '终端')

    await expect.poll(() => panel.getByLabel('命令超时（毫秒）').inputValue(), { timeout: 5_000 }).toBe('12000')
    expect(await settingsDocument()).toContain('timeoutMs: 12000')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('refuses to save a draft that is not a number', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-invalid'))
    const panel = await openPlugins()
    await openPage(panel, '终端')
    const timeout = panel.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('soon')

    const save = panel.getByRole('button', { name: '保存', exact: true })
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(await panel.getByText('请填数字；留空表示使用默认值。').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('clears the field back to the composed default on reset', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-reset'))
    const panel = await openPlugins()
    await openPage(panel, '终端')
    const timeout = panel.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })
    expect(await timeout.inputValue()).toBe('12000')

    // The reset stages the composed default; the document still carries the
    // override until the save lands.
    await panel.getByRole('button', { name: '恢复默认' }).click()
    await expect.poll(() => timeout.inputValue(), { timeout: 5_000 }).toBe('60000')
    expect(await settingsDocument()).toContain('timeoutMs: 12000')

    await panel.getByRole('button', { name: '保存', exact: true }).click()

    await expect.poll(async () => (await settingsDocument()).includes('timeoutMs'), { timeout: 10_000 })
      .toBe(false)
    expect(await timeout.inputValue()).toBe('60000')
    expect(await panel.getByText('已覆盖').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('renders a community bundle\'s row configuration, registered by its browser half, on the row\'s page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-row'))
    const panel = await openPlugins()

    // Off, the bundle's browser half is not loaded and the row has no configuration to open.
    await panel.getByRole('button', { name: '查看 @fixture/live-client', exact: true }).click()
    const row = panel.locator('[data-plugin-row]', { hasText: 'fixture-live-client' })
    await row.waitFor({ timeout: 10_000 })
    expect(await panel.getByRole('button', { name: '配置 @fixture/live-client' }).count()).toBe(0)

    // Off, the bundle's page carries no contribution either: the browser half
    // that would make them is not loaded.
    const bundlePage = panel.locator('[data-plugin-detail="@fixture/live-client"]')
    expect(await bundlePage.locator('[data-live-action]').count()).toBe(0)

    // Switched on, the Host recomposes and the browser half mounts without a
    // reload; its registration puts the configure control on the row, and
    // its detail contributions on the bundle's page: the action before the
    // page's own switch, the badge beside the title, the section after the rows.
    await panel.getByRole('switch', { name: '启用 @fixture/live-client' }).click()
    const configure = panel.getByRole('button', { name: '配置 @fixture/live-client' })
    await configure.waitFor({ timeout: 30_000 })
    await bundlePage.locator('[data-live-section="bundle"]').waitFor({ timeout: 10_000 })
    // The page's own view of the row follows the Host's change event, which
    // can land after the browser half mounted; the golden holds the settled page.
    await row.getByText('运行中', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await bundlePage.getByRole('button', { name: '夹具操作' }).count()).toBe(1)
    expect(await bundlePage.locator('[data-live-badge="bundle"]').textContent()).toBe('夹具标签')
    expect(await bundlePage.getByRole('region', { name: '夹具区块' }).getByText('来自夹具的区块内容').count()).toBe(1)
    const bundleSnapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(BUNDLE_EXPECTED, bundleSnapshot, MODE)
    await configure.click()

    const rowPage = panel.locator('[data-plugin-row-detail="@fixture/live-client#fixture-live-client"]')
    await rowPage.waitFor({ timeout: 10_000 })
    expect(await rowPage.getByRole('heading', { level: 3 }).textContent()).toBe('@fixture/live-client')
    expect(await rowPage.getByText('示例配置项', { exact: true }).count()).toBe(1)
    // The same entries render for the row's page, told it is about the row.
    expect(await rowPage.locator('[data-live-action="row"]').count()).toBe(1)
    expect(await rowPage.locator('[data-live-badge="row"]').count()).toBe(1)
    expect(await rowPage.locator('[data-live-section="row"]').count()).toBe(1)
    const form = rowPage.getByRole('form', { name: '动态插件配置' })
    await form.getByLabel('问候语').fill('你好')
    await form.getByRole('button', { name: '保存' }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.liveSaves), { timeout: 5_000 }).toBe('1')

    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ROW_EXPECTED, snapshot, MODE)
    await rowPage.getByRole('button', { name: '返回 @fixture/live-client' }).click()
    await bundlePage.waitFor({ timeout: 10_000 })

    // An official plugin's page is another subject; the fixture's entries render nothing for it.
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    await openPage(panel, '终端')
    const itemPage = panel.locator('[data-plugin-item-detail]')
    expect(await itemPage.locator('[data-live-action], [data-live-badge], [data-live-section]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['bundle.expected.md', 'official.expected.md', 'row.expected.md', 'subagent.expected.md'])
  })


})
