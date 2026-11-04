/** An installed connector stays off Installed, switches and opens from the Connectors tab, and stays off after that tab leaves. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const BUNDLE = '@deepseek-ai/dsh-experimental-connectors-bundle'
const FEISHU = '@deepseek-ai/dsh-feishu'
const EXPECTED = fileURLToPath(new URL('./expected/connectors-tab/connectors-tab.expected.md', import.meta.url))

it('lists the official connectors, switches an installed one from the tab, and keeps it off Installed when switched off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connectors-tab-web-'))
  const owned: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: FEISHU, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(root, 'cordis.patch.yml'), '[]\n')
  const scaffold = owned.scaffold = await launchWebScaffold({ profile: { packages: [{ dir: root, enabled: true }], bundles: [BUNDLE] } })
  const browser = owned.browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE, reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  const tab = panel.getByRole('tab', { name: '连接器', exact: true })
  await tab.waitFor()
  await panel.locator(`[data-plugin-package="${BUNDLE}"]`).waitFor()
  expect(await panel.locator(`[data-plugin-package="${FEISHU}"]`).count()).toBe(0)

  await tab.click()
  const feishu = panel.locator('[data-connector="feishu"]')
  await feishu.getByRole('button', { name: '打开 飞书插件', exact: true }).waitFor()
  const toggle = feishu.getByRole('switch')
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
  await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-connectors]', scaffold.workspaceCwd), webSnapshotMode())
  // The tab's switch is the Installed list's own: it applies through the Host and reads back the new state.
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
  await feishu.getByRole('button', { name: '打开 飞书插件', exact: true }).click()
  await panel.locator(`[data-plugin-detail="${FEISHU}"]`).waitFor()
  await panel.getByRole('button', { name: '返回插件', exact: true }).click()
  await feishu.waitFor()

  await panel.getByRole('tab', { name: '已安装', exact: true }).click()
  await panel.locator(`[data-plugin-package="${BUNDLE}"]`).getByRole('switch').click()
  await tab.waitFor({ state: 'detached' })
  expect(await panel.locator(`[data-plugin-package="${FEISHU}"]`).count()).toBe(0)
})
