// Web e2e scenario: connecting the Tencent Docs plugin from its page on the Plugins
// page. The section reads the MCP manager's real entry, the browser opens the
// loopback authorization server's page with the `docs:*` scopes and the
// endpoint's own query, the Host callback answers with its
// completion page, the connection reaches the manager, and sign-out returns the
// section to disconnected. Zero model calls.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { startTencentDocsOAuthFixture, type TencentDocsOAuthFixture } from './tencent-docs-oauth-fixture.ts'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const TENCENT_DOCS_DIR = fileURLToPath(new URL('../../../packages/connector/tencent-docs', import.meta.url))

describe('web e2e: Tencent Docs plugin connection', () => {
  let fixture: TencentDocsOAuthFixture
  let overlayDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    fixture = await startTencentDocsOAuthFixture()
    overlayDir = await mkdtemp(join(tmpdir(), 'dsh-tencent-docs-e2e-'))
    const overlay = join(overlayDir, 'tencent-docs.overlay.yml')
    await writeFile(overlay, `- id: tencent-docs\n  config:\n    url: ${fixture.origin}/mcp\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      profile: { packages: [{ dir: TENCENT_DOCS_DIR, enabled: true }] },
    })
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await fixture?.close()
    if (overlayDir !== undefined) await rm(overlayDir, { recursive: true, force: true })
  })

  it('connects the account from the plugin page and signs out after confirmation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-tencent-docs-connection'))
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('button', { name: '查看 腾讯文档', exact: true }).click({ timeout: 20_000 })
    const section = panel.locator('[data-connector-account]')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    expect(await panel.locator('[data-plugin-detail]').getByText('未连接', { exact: true }).count()).toBe(2)

    const opened = context.waitForEvent('page')
    await section.getByRole('button', { name: '连接腾讯文档', exact: true }).click()
    const authorization = await opened
    await expect.poll(async () => await authorization.locator('body').textContent(), { timeout: 20_000 })
      .toContain('已收到授权。可以关闭此页，回到 DSH 查看连接结果。')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('connected')
    await page.getByText('腾讯文档已连接', { exact: true }).waitFor({ timeout: 10_000 })
    expect(fixture.authorizations()).toBe(1)
    expect(fixture.authorizationQuery()?.get('authType')).toBe('2')
    expect(fixture.authorizationQuery()?.get('scope')).toBe('docs:read docs:write docs:manage')
    await authorization.close()

    await section.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出腾讯文档登录？' }).getByRole('button', { name: '退出登录', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    expect(tripwire.pageErrors).toEqual([])
  })
})
