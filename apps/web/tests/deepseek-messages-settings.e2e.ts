/** Opt-in Web Messages configuration, credential reuse, and recovery from a saved Chat Completions selection. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/deepseek-messages-settings/', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record')('web e2e: DeepSeek Messages opt-in', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, deepSeekMessages: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('offers one DeepSeek card and saves Messages settings using the existing credential reference', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-messages-settings'))
    expect(scaffold.ctx.llm.listProviders()).toContainEqual({ id: 'deepseek-official', name: 'DeepSeek' })
    expect(scaffold.ctx.llm.listProviders().filter(provider => provider.id === 'deepseek-official')).toHaveLength(1)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    const onboarding = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
    await onboarding.getByLabel('API 密钥', { exact: true }).fill('sk-messages-onboarding')
    await onboarding.getByRole('button', { name: '保存并继续' }).click()
    await onboarding.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByText('DeepSeek', { exact: true }).waitFor()
    expect(await dialog.getByText('DeepSeek', { exact: true }).count()).toBe(1)
    await dialog.getByText('DeepSeek', { exact: true }).locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    const messages = dialog
    await messages.getByText('自定义设置', { exact: true }).click()
    expect(await messages.getByLabel('API 地址', { exact: true }).getAttribute('placeholder'))
      .toBe('https://api.deepseek.com/anthropic')
    await compareOrRefreshGolden(join(EXPECTED, 'cards.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await messages.getByLabel('API 密钥', { exact: true }).fill('sk-e2e-messages')
    await messages.getByLabel('API 地址', { exact: true }).fill('https://messages.example/anthropic')
    expect(await messages.getByLabel('模型 ID 1').inputValue()).toBe('deepseek-flash')
    await messages.getByLabel('显示名称 1', { exact: true }).fill('Messages Flash')
    await messages.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 DeepSeek (deepseek-official)。', { exact: true }).waitFor()

    const settings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('https://messages.example/anthropic')
    expect(settings).toContain('llm-deepseek:')
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).resolves.toMatchObject({
      name: 'Messages Flash', inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history',
    })
    expect(scaffold.ctx.settings.get('llm-deepseek')).toMatchObject({ protocol: 'messages' })
    expect(settings).not.toContain('sk-e2e-')
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('DEEPSEEK_API_KEY: sk-e2e-messages')
    expect(credentials).not.toContain('DEEPSEEK_MESSAGES_API_KEY')
    expect(await page.locator('body').innerText()).not.toContain('sk-e2e-')
    await page.keyboard.press('Escape')
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'messages-settings-e2e')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Messages Flash', exact: true }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'picker.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps a saved Chat Completions selection available after the YAML protocol switch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-messages-default'))
    await page.keyboard.press('Escape')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    await page.reload({ waitUntil: 'load' })
    const input = page.locator('[data-composer-input]').first()
    await expect.poll(() => input.isEnabled()).toBe(true)
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Messages Flash', exact: true }).click()
    await expect.poll(() => input.isEnabled()).toBe(true)
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().provider).toBe('deepseek-official')
    const settings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('provider: deepseek-official')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
