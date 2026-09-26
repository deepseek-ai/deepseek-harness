/** The preset settings page selects a preset and shows what it declares; creating one starts a Creator-mode task. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/agent-preset-authoring', import.meta.url))
const mode = webSnapshotMode()

describe('web e2e: preset roster guidance', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { packages: [] } })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: 'Agent 预设' }).click()
    await page.getByRole('heading', { name: 'Agent 预设' }).waitFor()
  }, 120_000)
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('shows the shipped roster with mode help and a read-only view, and no editing actions', async () => {
    onTestFailed(() => saveFailureShot(page, 'preset-roster-section'))
    await expect.poll(() => page.locator('[data-agent-preset-id]').count()).toBe(4)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(EXPECTED, 'section.expected.md'), snapshot, mode)
    expect(snapshot).toContain('让 Agent 帮我创建预设模式')
    expect(snapshot).toContain('查看配置: 标准模式')
    expect(snapshot).not.toContain('复制预设')
    expect(snapshot).not.toContain('编辑插件')
    expect(snapshot).not.toContain('打开目录')
    expect(snapshot).not.toContain('删除')
  })

  it('reads mode details and examples without changing the new-task default', async () => {
    onTestFailed(() => saveFailureShot(page, 'preset-roster-guide'))
    const settings = page.getByRole('dialog', { name: '设置' })
    const trigger = settings.getByRole('button', { name: '模式说明: PTC 模式', exact: true })
    await trigger.click()
    const guide = page.getByRole('dialog', { name: 'PTC 模式', exact: true })
    await guide.getByRole('heading', { name: '怎样调用工具', exact: true }).waitFor()
    await guide.getByRole('tab', { name: '如何使用', exact: true }).click()
    await guide.getByRole('heading', { name: '批量检查配置文件', exact: true }).waitFor()
    await guide.getByRole('tab', { name: '如何使用', exact: true }).press('Escape')
    await guide.waitFor({ state: 'detached' })
    expect(await trigger.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await settings.getByRole('button', { name: '新任务默认: 标准模式', exact: true }).getAttribute('aria-pressed')).toBe('true')
  })

  it('views a shipped composition read-only', async () => {
    onTestFailed(() => saveFailureShot(page, 'preset-roster-view'))
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('button', { name: '查看配置: PTC 模式', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: '查看配置 · PTC 模式', exact: true })
    await viewer.waitFor({ timeout: 10_000 })
    // The real shipped declaration, not a golden: the viewer shows whatever
    // the deployment ships, and this lane only asserts it is shown read-only
    // in the Loader's own dialect.
    const shown = await viewer.locator('pre').textContent()
    expect(shown).toContain("- id: persona\n  name: '@deepseek-ai/dsh-persona'\n")
    expect(shown).toContain('- id: workflow-ptc\n')
    expect(shown).toContain("disabled: !!js process.platform === 'win32'\n")
    expect(shown).not.toContain('__jsExpr')
    expect(await viewer.getByRole('textbox').count()).toBe(0)
    // The header X and the footer button share the 关闭 name; the footer one is last.
    await viewer.getByRole('button', { name: '关闭', exact: true }).last().click()
    await viewer.waitFor({ state: 'detached', timeout: 10_000 })
    expect(await settings.getByRole('button', { name: '新任务默认: 标准模式', exact: true }).getAttribute('aria-pressed')).toBe('true')
  })

  it('starts a Creator-mode task from the section entry', async () => {
    onTestFailed(() => saveFailureShot(page, 'preset-roster-creator'))
    // The entry stages the self-referential preset and lands a new task on it,
    // so the flow needs a connected workspace to enter.
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).last().click()
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('button', { name: 'Agent 预设' }).click()
    await settings.getByRole('button', { name: '让 Agent 帮我创建预设模式', exact: true }).click()
    await settings.waitFor({ state: 'detached', timeout: 10_000 })
    await expect.poll(async () => {
      const response = await scaffold.hostFetch('/api/session/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'creator-draft-stage', method: 'session/list',
          payload: { args: { _request: {} } },
        }),
      })
      const body = await response.json() as {
        result: { value?: { items: { projections?: { values: { agentPreset?: string | null } } }[] } }
      }
      return body.result.value?.items
        .map(item => item.projections?.values.agentPreset)
        .filter(preset => typeof preset === 'string') ?? []
    }, { timeout: 15_000 }).toContain('cordis')
  })

  it('runs without page errors or model calls', () => { expect(tripwire.pageErrors).toEqual([]) })
})
