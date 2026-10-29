/** Unsupported Host platforms leave the profile and running PTC configuration untouched. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

it('disables unsupported bundles, shows the Host restriction, and refuses direct activation without changing PTC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-platform-web-'))
  const owned: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const name = 'host-platform-only'
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: {
    patch: './cordis.patch.yml', platforms: [process.platform === 'darwin' ? 'win32' : 'darwin'],
  } } }))
  await writeFile(join(root, 'cordis.patch.yml'), '- id: ptc-runtime\n  config:\n    executionMode: persistent-in-memory\n')
  const scaffold = owned.scaffold = await launchWebScaffold({ profile: { packages: [{ dir: root }] } })
  const browser = owned.browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const reason = '此插件不支持运行 DSH 的主机操作系统'
  const card = page.locator(`[data-plugin-package="${name}"]`)
  await card.getByText(reason, { exact: true }).waitFor()
  expect(await card.getByRole('switch').isEnabled()).toBe(false)
  expect(await card.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/bundle-platform/unsupported-platform.expected.md', import.meta.url)),
    await captureStableAria(page, `[data-plugin-package="${name}"] p[role="status"]`, scaffold.workspaceCwd), webSnapshotMode())
  const manifest = join(scaffold.harnessHome, 'profiles/scaffold/package.json')
  const before = await readFile(manifest, 'utf8')
  const runtimeId = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ptc-runtime')?.fiber?.uid
  const beforeRuntime = runtimeId()
  expect(beforeRuntime).toBeTypeOf('number')
  expect(scaffold.ctx.ptcRuntime.programFormat).toBe('function-body')
  const names = [name]
  await page.locator('[data-plugin-panel]').getByRole('button', { name: '更多', exact: true }).click()
  const cua = page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]')
  expect(await cua.count()).toBe(0)
  if (process.platform !== 'darwin') {
    expect((await scaffold.ctx.pluginManager.listBundles()).find(bundle => bundle.name === '@deepseek-ai/dsh-cua-bundle'))
      .toMatchObject({ listedByDefault: false, enabled: false, error: { code: 'unsupported-platform' } })
    names.push('@deepseek-ai/dsh-cua-bundle')
  }
  for (const bundle of names) {
    expect(await scaffold.ctx.pluginManager.setBundleEnabled(bundle, true)).toMatchObject({
      changed: false, application: 'failed', error: { code: 'unsupported-platform' },
    })
  }
  expect(await readFile(manifest, 'utf8')).toBe(before)
  expect(runtimeId()).toBe(beforeRuntime)
  expect(scaffold.ctx.ptcRuntime.programFormat).toBe('function-body')
  expect(scaffold.ctx.get('computerUse')).toBeUndefined()
})
