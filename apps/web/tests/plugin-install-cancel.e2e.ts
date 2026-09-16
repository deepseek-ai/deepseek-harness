// A real Host/Remote/browser composition with a controllable package-manager process.
// No model call is needed: installation state and profile files are the observable result.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, captureStableAria, compareOrRefreshGolden, webSnapshotMode, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('cancels installation through the UI, restores files, and offers the spec again', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-install-cancel-'))
  const overlay = join(scratch, 'cordis.patch.yml')
  await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`)
  let scaffold: WebScaffold | undefined
  try {
    scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
    const browser = await chromium.launch()
    try {
      const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
      const manifestPath = join(profile, 'package.json')
      const manifest = await readFile(manifestPath, 'utf8')
      const lockPath = join(profile, 'pnpm-lock.yaml')
      await writeFile(lockPath, 'original lockfile\n')
      // Node stands in for the pnpm executable: `view` answers the check that precedes the run,
      // and the same installer owns and stops the real `add` child.
      await writeFile(join(profile, 'view'), 'console.log(JSON.stringify({ name: "slow-package", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }))\n')
      await writeFile(join(profile, 'add'), `
        import('node:fs').then(fs => {
        fs.writeFileSync('package.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('package.json', 'utf8')), dependencies: { partial: '1.0.0' } }));
        fs.writeFileSync('pnpm-lock.yaml', 'partial lockfile');
        console.log('Waiting for package download');
        setInterval(() => {}, 1000);
        });
      `)
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      if (await page.getByRole('dialog', { name: '设置' }).count() > 0) await page.keyboard.press('Escape')
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.getByRole('button', { name: '添加插件', exact: true }).click()
      // The dialog is named after its current screen, so it is found by role alone.
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox').fill('slow-package')
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      // The check passed: the running screen names the package and folds pnpm's output behind the details.
      await dialog.getByText('版本 1.0.0', { exact: true }).waitFor()
      await dialog.getByRole('button', { name: '查看安装详情', exact: true }).click()
      await dialog.getByText('Waiting for package download', { exact: true }).waitFor()
      await dialog.getByRole('button', { name: '取消安装', exact: true }).click()
      // The Host's confirmation returns the dialog to the spec and says so in a toast.
      await page.getByText('已取消安装，插件未启用，下载的文件可能保留', { exact: true }).waitFor()
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
      expect(await readFile(lockPath, 'utf8')).toBe('original lockfile\n')
      expect(await dialog.getByRole('textbox').inputValue()).toBe('slow-package')
      const snapshot = (await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd))
        .split(process.execPath).join('{{node}}')
        .split(scaffold.harnessHome).join('{{harnessHome}}')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-cancel/cancelled.expected.md', import.meta.url)), snapshot, webSnapshotMode())
      // The second run installs a bundle the way pnpm leaves one: the dependency in the manifest and the package under node_modules.
      await writeFile(join(profile, 'add'), `
        import('node:fs').then(fs => {
        fs.mkdirSync('node_modules/slow-package', { recursive: true });
        fs.writeFileSync('node_modules/slow-package/package.json', JSON.stringify({ name: 'slow-package', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
        fs.writeFileSync('node_modules/slow-package/cordis.patch.yml', '[]\\n');
        fs.writeFileSync('package.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('package.json', 'utf8')), dependencies: { 'slow-package': '1.0.0' } }));
        console.log('Retry completed');
        });
      `)
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      await dialog.getByRole('button', { name: '立即启用', exact: true }).waitFor()
      await dialog.getByRole('button', { name: '查看安装详情', exact: true }).click()
      await dialog.getByText('Retry completed', { exact: true }).waitFor()
      expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({ dependencies: { 'slow-package': '1.0.0' } })
      expect(tripwire.pageErrors).toEqual([])
    } finally { await browser.close() }
  } finally {
    await scaffold?.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
