/** Web DeepSeek configuration, credential reuse, and saved model selection. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/deepseek-messages-settings/', import.meta.url))

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
  'keeps a foreign model drag from editing another provider input in $name', async ({ engine }) => {
    const scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    let browser: Browser | undefined
    try {
      browser = await engine.launch()
      const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('dialog', { name: '开始使用', exact: true }).getByRole('button', { name: '添加 API Key', exact: true }).click()
      await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).getByRole('button', { name: '稍后配置' }).click()
      await openSettings(page, 'zh')
      const dialog = page.getByRole('dialog', { name: '设置', exact: true })
      await dialog.getByRole('button', { name: '模型', exact: true }).click()
      const setup = dialog.getByText('DeepSeek', { exact: true }).locator('xpath=ancestor::li')
      await setup.getByText('自定义设置', { exact: true }).click()
      await dialog.getByRole('button', { name: '添加模型提供商' }).click()
      await dialog.getByRole('tab', { name: '自定义模型 API' }).click()
      const custom = dialog.getByRole('tabpanel', { name: '自定义模型 API' })
      await custom.getByRole('button', { name: '添加模型', exact: true }).click()
      const target = custom.getByLabel('模型 ID 1', { exact: true })
      await target.fill('foreign-model')
      const before = scaffold.ctx.settings.describe({ redactSecrets: true }).map(row => ({ ns: row.ns, value: row.value }))
      const source = setup.getByRole('button', { name: '调整模型顺序 1', exact: true })
      await source.dragTo(target)
      expect(await target.inputValue()).toBe('foreign-model')
      expect(await setup.getByLabel('模型 ID 1', { exact: true }).inputValue()).toBe('deepseek-flash')
      expect(scaffold.ctx.settings.describe({ redactSecrets: true }).map(row => ({ ns: row.ns, value: row.value }))).toEqual(before)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      try {
        await browser?.close()
      } finally {
        await scaffold.close()
      }
    }
  }, 60_000,
)

describe.skipIf(webSnapshotMode() === 'record')('web e2e: DeepSeek Messages settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
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
    await page.getByRole('dialog', { name: '开始使用', exact: true }).getByRole('button', { name: '添加 API Key', exact: true }).click()
    const onboarding = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
    await onboarding.getByLabel('API 密钥', { exact: true }).fill('sk-messages-onboarding')
    await onboarding.getByRole('button', { name: '保存并继续' }).click()
    await onboarding.waitFor({ state: 'detached' })
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByText('DeepSeek', { exact: true }).waitFor()
    expect(await dialog.getByText('DeepSeek', { exact: true }).count()).toBe(1)
    await dialog.getByText('DeepSeek', { exact: true }).locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    const messages = dialog
    await messages.getByText('自定义设置', { exact: true }).click()
    expect(await messages.getByLabel('API 地址', { exact: true }).getAttribute('placeholder'))
      .toBe('https://api.deepseek.com/anthropic（默认使用环境 DEEPSEEK_BASE_URL）')
    await compareOrRefreshGolden(join(EXPECTED, 'cards.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await messages.getByLabel('API 密钥', { exact: true }).fill('sk-e2e-messages')
    await messages.getByLabel('API 地址', { exact: true }).fill('https://messages.example/anthropic')
    expect(await messages.getByLabel('模型 ID 1').inputValue()).toBe('deepseek-flash')
    await messages.getByLabel('显示名称 1', { exact: true }).fill('Messages Flash')
    await messages.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 DeepSeek (deepseek-official)。', { exact: true }).waitFor()

    const settings = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(settings).toContain('https://messages.example/anthropic')
    expect(settings).toContain('id: llm-deepseek')
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).resolves.toMatchObject({
      name: 'Messages Flash', inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history',
    })
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'llm-deepseek')?.value).not.toHaveProperty('protocol')
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
      await captureStableAria(page, '[role="group"][aria-label="模型与推理等级"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.keyboard.press('Escape')
    await page.getByRole('menuitem', { name: /推理等级/ }).click()
    const effortWeights = await page.getByRole('menuitemradio').evaluateAll(rows => rows.map(row =>
      getComputedStyle(row.querySelector('span span')!).fontWeight,
    ))
    expect(new Set(effortWeights)).toEqual(new Set(['400']))
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('selects an available DeepSeek model after provider settings remove the default', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-messages-default'))
    await page.keyboard.press('Escape')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const patchPath = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
    expect(await readFile(patchPath, 'utf8')).toContain('model: deepseek-v4-flash')
    await page.reload({ waitUntil: 'load' })
    const input = page.locator('[data-composer-input]').first()
    const trigger = page.getByRole('button', { name: '请选择模型', exact: true })
    await trigger.waitFor()
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await expect.poll(() => input.getAttribute('contenteditable')).toBe('true')
    await trigger.click()
    await page.getByRole('menuitemradio', { name: 'Messages Flash', exact: true }).click()
    await expect.poll(() => input.getAttribute('contenteditable')).toBe('true')
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject({
      provider: 'deepseek-official', model: 'deepseek-flash',
    })
    const settings = await readFile(patchPath, 'utf8')
    expect(settings).not.toContain('id: agent-default-model')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
