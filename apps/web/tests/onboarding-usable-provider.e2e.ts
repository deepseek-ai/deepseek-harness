// Keyless browser e2e: a user who configures some OTHER provider is not asked
// for the official DeepSeek key again, and the first-run setup card is a card
// they can close. The shipped DeepSeek adapter stays mounted without a
// credential throughout, so the only thing that ends onboarding here is the
// pi-ai route the user configures through the real wire. Zero model calls:
// configuration is pure settings/credentials/llm-domain traffic.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/onboarding-usable-provider', import.meta.url))
const DISMISSED_EXPECTED = join(SNAPSHOT_DIR, 'dismissed.expected.md')
const MODE = webSnapshotMode()
const CREDENTIAL_STEP = '添加一个 API Key 开始使用'

describe.skipIf(MODE === 'record')('web e2e: another usable provider ends first-run onboarding', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('closes the setup card without discarding the add card beside it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-setup-card-cancel'))
    const credentialStep = page.getByRole('dialog', { name: CREDENTIAL_STEP })
    await credentialStep.waitFor({ timeout: 15_000 })
    expect(await page.getByRole('dialog', { name: '开始你的创作' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '账号菜单', exact: true }).count()).toBe(0)
    await credentialStep.getByRole('button', { name: '稍后配置' }).click()
    await credentialStep.waitFor({ state: 'detached', timeout: 15_000 })

    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    // Dismissing the onboarding step leaves Settings closed, so enter the
    // Models section explicitly before exercising its normal cards.
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    const setupKey = settings.getByRole('textbox', { name: 'API 密钥', exact: true })
    await setupKey.waitFor({ timeout: 10_000 })

    const add = settings.getByRole('button', { name: '添加模型提供商' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = settings.getByLabel('提供商', { exact: true })
    await pick.waitFor({ timeout: 10_000 })
    await pick.selectOption('minimax-cn')
    await expect.poll(
      async () => settings.getByRole('textbox', { name: 'API 密钥', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(2)

    // Cancelling the setup card must not close the independent add-provider
    // draft beside it.
    await settings.getByRole('button', { name: '取消', exact: true }).first().click()
    expect(await settings.getByLabel('提供商', { exact: true }).count()).toBe(1)
    await expect.poll(
      async () => settings.getByRole('textbox', { name: 'API 密钥', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)
    await settings.getByRole('button', { name: '编辑 DeepSeek (deepseek-official)' }).waitFor({ timeout: 10_000 })
    const dismissed = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DISMISSED_EXPECTED, dismissed, MODE)

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stops prompting for DeepSeek once the other provider can serve requests', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-other-provider'))
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-minimax')
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 15_000 })

    // Only minimax-cn is reachable; DeepSeek still holds no credential.
    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(credentials).not.toContain('DEEPSEEK_API_KEY')

    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    // The regression: the step read only the official route's credential, so a
    // fully configured user was taken over on every blank session.
    await expect.poll(
      async () => page.getByRole('dialog', { name: CREDENTIAL_STEP }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    // The Models page agrees: DeepSeek stays a row rather than reopening its
    // setup card over a user who already has somewhere to send a request.
    await openSettings(page, 'zh')
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    await settings.getByRole('button', { name: '编辑 DeepSeek (deepseek-official)' }).waitFor({ timeout: 10_000 })
    expect(await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).count()).toBe(0)

    expect((await page.content()).includes('sk-e2e-minimax')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['dismissed.expected.md'])
  })
})
