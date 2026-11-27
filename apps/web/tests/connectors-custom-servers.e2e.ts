/**
 * A remote server added on its Connectors tab page is an MCP server row of the profile patch whose token stays in
 * credentials: the row follows its switch, the manager probes with the stored token, and the removal deletes both.
 * The server's page stands in place of the Plugins page's title and tabs, under the crumb back to the Connectors tab.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { startHttpMcpFixture, type HttpMcpFixture } from '../../../packages/mcp/mcp-client/tests/http-fixture.ts'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const BUNDLE = '@deepseek-ai/dsh-client-ui-connectors'
const ROW = 'mcp-server-fixture'

/** One item of a profile patch: an override that names a row, or the rows the patch adds. */
interface PatchItem {
  readonly id?: string
  readonly insert?: readonly { readonly id: string }[]
}

it('opens a server\'s page under the Plugins page\'s crumb, adds a remote server with a bearer token as a server row, switches the row off and on, tests it with the stored token, and removes the row and the token', async () => {
  const owned: { scaffold?: WebScaffold; browser?: Browser; fixture?: HttpMcpFixture } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await owned.fixture?.close() }
    }
  })
  const fixture = owned.fixture = await startHttpMcpFixture()
  const scaffold = owned.scaffold = await launchWebScaffold({ profile: { packages: [], bundles: [BUNDLE] } })
  const home = (...path: string[]): Promise<string> => readFile(join(scaffold.harnessHome, ...path), 'utf8')
  /** What the profile patch holds for the server: the row it adds, then each override that names the row. */
  const patched = async (): Promise<unknown[]> => (yaml.load(await home('profiles', 'scaffold', 'cordis.patch.yml')) as PatchItem[])
    .flatMap(item => item.insert?.filter(row => row.id === ROW) ?? (item.id === ROW ? [item] : []))
  const browser = owned.browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE, reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  await panel.getByRole('tab', { name: '连接器', exact: true }).click()
  const section = panel.locator('[data-custom-servers]')
  await section.getByText('还没有自定义服务器。').waitFor()

  await panel.getByRole('button', { name: '添加 MCP 服务器', exact: true }).click()
  const serverPage = panel.locator('[data-custom-server-page]')
  await serverPage.getByRole('heading', { name: '添加 MCP 服务器' }).waitFor()
  // The server's page stands in place of the Plugins page's title and tabs, under one crumb that names the tab.
  const pageTitle = panel.getByRole('heading', { name: '插件', exact: true, level: 1 })
  const installedTab = panel.getByRole('tab', { name: '已安装', exact: true })
  const crumb = panel.getByRole('button', { name: '返回 连接器', exact: true })
  expect(await crumb.textContent()).toBe('连接器')
  expect(await pageTitle.count()).toBe(0)
  expect(await installedTab.count()).toBe(0)
  // The crumb is the way out of a started form, back to the tab's lists.
  await serverPage.getByRole('textbox', { name: '名称', exact: true }).fill('started')
  await crumb.click()
  await serverPage.waitFor({ state: 'detached' })
  await pageTitle.waitFor()
  await installedTab.waitFor()
  await section.getByText('还没有自定义服务器。').waitFor()
  expect(await panel.getByRole('tab', { name: '连接器', exact: true }).getAttribute('aria-selected')).toBe('true')

  await panel.getByRole('button', { name: '添加 MCP 服务器', exact: true }).click()
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
  // The row names the token by its credential reference; the token itself is in credentials only.
  const added = {
    id: ROW,
    name: '@deepseek-ai/dsh-mcp-manager/server',
    config: { serverName: 'fixture', transport: 'streamable-http', url: fixture.url, headers: { Authorization: 'Bearer ${credential:MCP_FIXTURE_TOKEN}' } },
  }
  expect(await patched()).toEqual([added])
  expect(await home('.credentials.yaml')).toContain('MCP_FIXTURE_TOKEN: fixture-token')

  const enabled = (checked: boolean) => row.getByRole('switch', { name: '启用 fixture', exact: true, checked })
  await enabled(true).click()
  await enabled(false).waitFor()
  expect(await patched()).toEqual([added, { id: ROW, disabled: true }])
  await enabled(false).click()
  await enabled(true).waitFor()
  expect(await patched()).toEqual([added])

  await row.getByRole('button', { name: 'fixture 的设置', exact: true }).click()
  await serverPage.getByRole('button', { name: '测试连接', exact: true }).click()
  await serverPage.getByText('连接成功，共 1 个工具').waitFor()
  expect(fixture.authorization).toContain('Bearer fixture-token')

  await serverPage.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除 fixture？' }).getByRole('button', { name: '删除', exact: true }).click()
  await section.getByText('还没有自定义服务器。').waitFor()
  expect(await patched()).toEqual([])
  // The removal deletes the token after the row, so the list can be empty before the token is gone.
  await expect.poll(() => home('.credentials.yaml'), { timeout: 10_000 }).not.toContain('MCP_FIXTURE_TOKEN')
})
