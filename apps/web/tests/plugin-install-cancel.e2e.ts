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
    const delivery = Promise.withResolvers<undefined>()
    const cancellationReply = Promise.withResolvers<undefined>()
    const loseActiveReply = Promise.withResolvers<undefined>()
    try {
      const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
      const manifestPath = join(profile, 'package.json')
      const manifest = await readFile(manifestPath, 'utf8')
      const lockPath = join(profile, 'pnpm-lock.yaml')
      await writeFile(lockPath, 'original lockfile\n')
      // Node stands in for the pnpm executable: `view` answers the check that precedes the run,
      // and the same installer owns and stops the real `add` child.
      await writeFile(join(profile, 'view'), 'console.log(JSON.stringify({ name: process.argv[2], version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }))\n')
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
      // Hold request delivery and the real Host's cancellation reply independently.
      // Cancellation reaches the Host before the install it names.
      const cancellationArrived = Promise.withResolvers<undefined>()
      await page.route('**/api/pluginManager/installBundle', async (route) => {
        await delivery.promise
        await route.continue()
      })
      await page.route('**/api/pluginManager/cancelInstall', async (route) => {
        const response = await route.fetch()
        cancellationArrived.resolve(undefined)
        await cancellationReply.promise
        await route.fulfill({ response })
      })
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      await dialog.getByText('正在准备安装…', { exact: true }).waitFor()
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-cancel/preparing.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await dialog.getByRole('button', { name: '取消安装并关闭', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await cancellationArrived.promise
      await panel.getByRole('button', { name: '查看安装任务', exact: true }).click()
      await dialog.getByText('正在停止安装…', { exact: true }).first().waitFor()
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      cancellationReply.resolve(undefined)
      await page.getByText('安装状态暂未确认，请查看安装任务了解详情。', { exact: true }).waitFor()
      await panel.getByRole('button', { name: '查看安装任务', exact: true }).click()
      await dialog.getByText('安装状态尚未确认', { exact: true }).waitFor()
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-cancel/unconfirmed.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await page.locator('[role="presentation"] > [aria-hidden="true"]').click({ position: { x: 5, y: 5 } })
      await dialog.waitFor({ state: 'hidden' })
      delivery.resolve(undefined)
      await page.getByText('已取消安装，插件未启用，下载的文件可能保留', { exact: true }).waitFor()
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
      expect(await readFile(lockPath, 'utf8')).toBe('original lockfile\n')
      await page.unrouteAll({ behavior: 'wait' })
      // Drop the browser's response while the real Host still owns the child process.
      const activeReplySettled = Promise.withResolvers<undefined>()
      await page.route('**/api/pluginManager/installBundle', async (route) => {
        const response = route.fetch().then(() => undefined, (error: unknown) => error)
        try {
          await loseActiveReply.promise
          await route.abort('failed')
          expect(await response).toBeUndefined()
        } finally {
          activeReplySettled.resolve(undefined)
        }
      })
      await panel.getByRole('button', { name: '添加插件', exact: true }).click()
      await dialog.getByRole('textbox').fill('slow-package')
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      // The check passed: the running screen names the package and folds pnpm's output behind the details.
      await dialog.getByText('版本 1.0.0', { exact: true }).waitFor()
      await dialog.getByRole('button', { name: '查看安装详情', exact: true }).click()
      await dialog.getByText('Waiting for package download', { exact: true }).waitFor()
      loseActiveReply.resolve(undefined)
      await dialog.getByRole('button', { name: '核对安装状态', exact: true }).waitFor()
      await dialog.getByRole('button', { name: '取消安装', exact: true }).click()
      // The Host's confirmation returns the dialog to the spec and says so in a toast.
      await dialog.getByRole('textbox').waitFor()
      await page.getByText('已取消安装，插件未启用，下载的文件可能保留', { exact: true }).waitFor()
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
      expect(await readFile(lockPath, 'utf8')).toBe('original lockfile\n')
      expect(await dialog.getByRole('textbox').inputValue()).toBe('slow-package')
      await activeReplySettled.promise
      await page.unrouteAll({ behavior: 'wait' })
      const snapshot = (await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd))
        .split(process.execPath).join('{{node}}')
        .split(scaffold.harnessHome).join('{{harnessHome}}')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-cancel/cancelled.expected.md', import.meta.url)), snapshot, webSnapshotMode())
      // Successful runs leave the dependency in the manifest and the bundle under node_modules.
      await writeFile(join(profile, 'add'), `
        import('node:fs').then(fs => {
        const name = process.argv[2];
        fs.mkdirSync('node_modules/' + name, { recursive: true });
        fs.writeFileSync('node_modules/' + name + '/package.json', JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
        fs.writeFileSync('node_modules/' + name + '/cordis.patch.yml', '[]\\n');
        fs.writeFileSync('package.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('package.json', 'utf8')), dependencies: { ...JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies, [name]: '1.0.0' } }));
        console.log('Retry completed');
        });
      `)
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      await dialog.getByRole('button', { name: '立即启用', exact: true }).waitFor()
      await dialog.getByRole('button', { name: '查看安装详情', exact: true }).click()
      await dialog.getByText('Retry completed', { exact: true }).waitFor()
      expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({ dependencies: { 'slow-package': '1.0.0' } })
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await panel.getByRole('button', { name: '添加插件', exact: true }).click()
      await dialog.getByRole('textbox').fill('recovered-package')
      await page.route('**/api/pluginManager/installBundle', async (route) => {
        await route.fetch()
        await route.abort('failed')
      })
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      await dialog.getByText('未能获取安装结果', { exact: true }).waitFor()
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-cancel/unknown.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({ dependencies: { 'recovered-package': '1.0.0' } })
      await dialog.getByRole('button', { name: '返回编辑', exact: true }).click()
      await dialog.getByRole('textbox').fill('another-package')
      expect(await dialog.getByRole('button', { name: '安装', exact: true }).isEnabled()).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      delivery.resolve(undefined)
      cancellationReply.resolve(undefined)
      loseActiveReply.resolve(undefined)
      await browser.close()
    }
  } finally {
    await scaffold?.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
