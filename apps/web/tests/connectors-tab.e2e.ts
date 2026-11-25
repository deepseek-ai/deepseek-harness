/**
 * The Connectors tab lists the official connectors, opens and switches an installed one, and installs a missing one in
 * the page's dialog.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const BUNDLE = '@deepseek-ai/dsh-client-ui-connectors'
const FEISHU = '@deepseek-ai/dsh-feishu'
const WECOM = '@deepseek-ai/dsh-wecom'
const EXPECTED = fileURLToPath(new URL('./expected/connectors-tab/connectors-tab.expected.md', import.meta.url))

/**
 * A stand-in connector bundle: its patch inserts its own row, an empty plugin. The workspace's connector package of the
 * same name resolves first as the bundle layer and inserts the same row, which imports this entry.
 */
const connectorFiles = (name: string, id: string, version: string) => ({
  'package.json': JSON.stringify({ name, version, type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  'cordis.patch.yml': `- insert:\n    - id: ${id}\n      name: '${name}'\n`,
  'index.js': 'export function apply() {}\n',
})

it('lists the official connectors, opens and switches an installed one, and installs a missing one at the running DSH version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connectors-tab-web-'))
  const owned: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
  const feishuDir = join(root, 'feishu')
  await mkdir(feishuDir)
  for (const [file, text] of Object.entries(connectorFiles(FEISHU, 'feishu', '1.0.0'))) await writeFile(join(feishuDir, file), text)
  const overlay = join(root, 'cordis.patch.yml')
  await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`)
  const scaffold = owned.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: feishuDir, enabled: true }], bundles: [BUNDLE] }, extraOverlayPath: overlay,
  })
  // Node stands in for pnpm and runs the profile directory's file named after the subcommand: `config` names the
  // registry, `view` answers with the WeCom bundle at the asked version, and `add` records its arguments and installs it.
  const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
  const wecom = connectorFiles(WECOM, 'wecom', version)
  await writeFile(join(profile, 'config'), 'console.log("https://registry.npmjs.org/")\n')
  await writeFile(join(profile, 'view'), `console.log(${JSON.stringify(wecom['package.json'])})\n`)
  await writeFile(join(profile, 'add'), `
    const fs = require('node:fs')
    fs.writeFileSync('.added', JSON.stringify(process.argv.slice(2)))
    fs.mkdirSync('node_modules/${WECOM}', { recursive: true })
    for (const [file, text] of Object.entries(${JSON.stringify(wecom)})) fs.writeFileSync('node_modules/${WECOM}/' + file, text)
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    fs.writeFileSync('package.json', JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, '${WECOM}': '${version}' } }))
  `)
  const browser = owned.browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE, reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  const tab = panel.getByRole('tab', { name: '连接器', exact: true })
  await tab.waitFor()
  // An installed connector keeps its card on Installed.
  await panel.locator(`[data-plugin-package="${FEISHU}"]`).waitFor()

  await tab.click()
  const feishu = panel.locator('[data-connector="feishu"]')
  await feishu.getByRole('button', { name: '打开 飞书', exact: true }).waitFor()
  const feishuSwitch = (checked: boolean) => feishu.getByRole('switch', { name: '飞书', exact: true, checked })
  await feishuSwitch(true).waitFor()
  await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-connectors]', scaffold.workspaceCwd), webSnapshotMode())
  // The switch changes the bundle and leaves the tab open; the row shows the state the Host answers after each change.
  await feishuSwitch(true).click()
  await feishuSwitch(false).waitFor()
  await feishuSwitch(false).click()
  await feishuSwitch(true).waitFor()
  expect(await panel.locator(`[data-plugin-detail="${FEISHU}"]`).count()).toBe(0)
  // The row opens the page as an Installed card does: a click on its description reaches the name button.
  const description = (await feishu.getByText('在对话中使用飞书文档、消息及其他已授权的功能。').boundingBox())!
  const rowBox = (await feishu.boundingBox())!
  const position = { x: description.x - rowBox.x + description.width / 2, y: description.y - rowBox.y + description.height / 2 }
  await feishu.click({ position })
  await panel.locator(`[data-plugin-detail="${FEISHU}"]`).waitFor()
  await panel.getByRole('button', { name: '返回插件', exact: true }).click()
  await feishu.waitFor()

  // Install hands the page's dialog the connector at the running DSH version; the dialog names it by the tab's title.
  const wecomRow = panel.locator('[data-connector="wecom"]')
  await wecomRow.getByRole('button', { name: '安装 企业微信', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const enableNow = dialog.getByRole('button', { name: '立即启用', exact: true })
  await enableNow.waitFor({ timeout: 20_000 })
  await dialog.getByText('企业微信', { exact: true }).waitFor()
  expect(JSON.parse(await readFile(join(profile, '.added'), 'utf8'))).toContain(`${WECOM}@${version}`)
  await enableNow.click()
  await wecomRow.getByRole('button', { name: '打开 企业微信', exact: true }).waitFor()
  await wecomRow.getByRole('switch', { name: '企业微信', exact: true, checked: true }).waitFor()

  // Switching the bundle off removes only the tab: the connectors stay installed and listed.
  await panel.getByRole('tab', { name: '已安装', exact: true }).click()
  await panel.locator(`[data-plugin-package="${BUNDLE}"]`).getByRole('switch').click()
  await tab.waitFor({ state: 'detached' })
  expect(await panel.locator(`[data-plugin-package="${FEISHU}"]`).count()).toBe(1)
  expect(await panel.locator(`[data-plugin-package="${WECOM}"]`).count()).toBe(1)
})
