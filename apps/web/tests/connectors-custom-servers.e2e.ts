/** A remote server added on its Connectors tab page keeps its token in credentials, and the manager probes with it. */
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { startHttpMcpFixture, type HttpMcpFixture } from '../../../packages/mcp/mcp-client/tests/http-fixture.ts'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const BUNDLE = '@deepseek-ai/dsh-client-ui-connectors'

it('adds a remote server with a bearer token, tests it from its page with the stored token, and removes it there', async () => {
  const owned: { scaffold?: WebScaffold; browser?: Browser; fixture?: HttpMcpFixture } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await owned.fixture?.close() }
    }
  })
  const fixture = owned.fixture = await startHttpMcpFixture()
  const scaffold = owned.scaffold = await launchWebScaffold({ profile: { packages: [], bundles: [BUNDLE] } })
  const browser = owned.browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE, reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  await panel.getByRole('tab', { name: '连接器', exact: true }).click()
  const section = panel.locator('[data-custom-servers]')
  await section.getByText('还没有自定义服务器。').waitFor()

  await section.getByRole('button', { name: '添加 MCP 服务器', exact: true }).click()
  const serverPage = panel.locator('[data-custom-server-page]')
  await serverPage.getByRole('heading', { name: '添加 MCP 服务器' }).waitFor()
  await serverPage.getByRole('textbox', { name: '名称', exact: true }).fill('fixture')
  await serverPage.getByRole('textbox', { name: 'URL', exact: true }).fill(fixture.url)
  await serverPage.getByRole('tab', { name: 'Bearer 令牌', exact: true }).click()
  await serverPage.getByLabel('令牌', { exact: true }).fill('fixture-token')
  await serverPage.getByRole('button', { name: '保存', exact: true }).click()
  await serverPage.waitFor({ state: 'detached' })
  const row = section.locator('[data-custom-server="fixture"]')
  await row.getByText(fixture.url, { exact: true }).waitFor()
  // A server without OAuth has no account, so its row shows no account status.
  expect(await row.locator('[data-connector-account]').count()).toBe(0)

  await row.getByRole('button', { name: 'fixture 的设置', exact: true }).click()
  await serverPage.getByRole('button', { name: '测试连接', exact: true }).click()
  await serverPage.getByText('连接成功，共 1 个工具').waitFor()
  expect(fixture.authorization).toContain('Bearer fixture-token')

  await serverPage.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除 fixture？' }).getByRole('button', { name: '删除', exact: true }).click()
  await section.getByText('还没有自定义服务器。').waitFor()
})
