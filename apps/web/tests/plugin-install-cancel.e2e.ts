// A real Host/Remote/browser composition with a controllable package-manager process.
// No model call is needed: installation state and profile files are the observable result.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page, type Route } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, captureStableAria, compareOrRefreshGolden, webSnapshotMode, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

async function invalidInputStyles(page: Page, input: Locator) {
  const styles = []
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(colorScheme === 'dark' ? '' : null)
      await input.focus()
      await expect.poll(() => input.evaluate(element => document.activeElement === element)).toBe(true)
      expect(await input.getAttribute('aria-invalid')).toBe('true')
      const { focused, focusRingColor, errorBorderColor } = await input.evaluate((element) => {
        const style = getComputedStyle(element)
        const probe = document.createElement('span')
        probe.style.display = 'none'
        probe.style.color = style.getPropertyValue('--dsw-focus-ring-color').trim() || style.getPropertyValue('--dsw-alias-state-business-primary')
        element.after(probe)
        try {
          const focusRingColor = getComputedStyle(probe).color
          probe.style.color = style.getPropertyValue('--dsw-alias-state-error-primary')
          return {
            focused: { outline: style.outlineStyle, boxShadow: style.boxShadow, borderColor: style.borderColor },
            focusRingColor,
            errorBorderColor: getComputedStyle(probe).color,
          }
        } finally {
          probe.remove()
        }
      })
      expect(focused.outline).toBe('none')
      expect(focused.boxShadow).toContain('inset')
      expect(focused.boxShadow).toContain('0px 0px 0px 0.5px')
      expect(focused.boxShadow).toContain(focusRingColor)
      expect(focused.borderColor).toBe(errorBorderColor)
      expect(focusRingColor).not.toBe(errorBorderColor)
      await input.evaluate((element) => { (element as HTMLInputElement).blur() })
      await expect.poll(() => input.evaluate(element => document.activeElement === element)).toBe(false)
      const blurred = await input.evaluate((element) => {
        const style = getComputedStyle(element)
        return { outline: style.outlineStyle, boxShadow: style.boxShadow, borderColor: style.borderColor }
      })
      expect(blurred).toEqual({ outline: 'none', boxShadow: 'none', borderColor: focused.borderColor })
      styles.push({ colorScheme, focused, blurred })
    }
    return styles
  } finally {
    await page.emulateMedia({ colorScheme: null })
  }
}

it('cancels installation, retries and highlights the enabled plugin at 40% alpha, and recovers unknown results', async () => {
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
      // Hold request delivery and the real Host's cancellation reply independently.
      // Cancellation reaches the Host before the install it names.
      const cancellationArrived = Promise.withResolvers<undefined>()
      let installBundleRoute = async (route: Route): Promise<void> => {
        await delivery.promise
        await route.continue()
      }
      let cancelInstallRoute = async (route: Route): Promise<void> => {
        const response = await route.fetch()
        cancellationArrived.resolve(undefined)
        await cancellationReply.promise
        await route.fulfill({ response })
      }
      // Host invalidations keep reading the directory between install phases.
      // Interception stays enabled from before navigation until page closure,
      // so phase changes cannot strand those requests.
      await page.route('**/api/pluginManager/installBundle', route => installBundleRoute(route))
      await page.route('**/api/pluginManager/cancelInstall', route => cancelInstallRoute(route))
      await page.clock.install()
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      if (await page.getByRole('dialog', { name: '设置' }).count() > 0) await page.keyboard.press('Escape')
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.getByRole('button', { name: '添加插件', exact: true }).click()
      // The dialog is named after its current screen, so it is found by role alone.
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox').fill('slow-package')
      await dialog.getByRole('button', { name: /^安装源/ }).click()
      const registryMenu = page.locator('[data-install-registry]')
      const customAddress = registryMenu.getByRole('textbox', { name: '自定义地址', exact: true })
      await customAddress.fill('invalid-registry')
      await page.keyboard.press('Escape')
      await registryMenu.waitFor({ state: 'hidden' })
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      await customAddress.waitFor({ state: 'visible' })
      await expect.poll(() => customAddress.evaluate(element => document.activeElement === element)).toBe(true)
      expect(await customAddress.getAttribute('aria-invalid')).toBe('true')
      const registryStyles = await invalidInputStyles(page, customAddress)
      const invalidRegistryAria = await captureStableAria(page, '[data-install-registry] > [data-checked="true"]', scaffold.workspaceCwd)
      await registryMenu.getByRole('radio').first().check()
      await page.keyboard.press('Escape')
      await registryMenu.waitFor({ state: 'hidden' })
      const packageName = dialog.getByRole('textbox', { name: '包名或地址', exact: true })
      await packageName.fill('./relative')
      await packageName.press('Enter')
      await expect.poll(() => packageName.getAttribute('aria-invalid')).toBe('true')
      const packageStyles = await invalidInputStyles(page, packageName)
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-cancel/invalid-registry.expected.md', import.meta.url)),
        `${invalidRegistryAria}\n\n${JSON.stringify({ registry: registryStyles, packageName: packageStyles }, null, 2)}`, webSnapshotMode())
      await packageName.fill('slow-package')
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
      cancelInstallRoute = route => route.continue()
      // Drop the browser's response while the real Host still owns the child process.
      const activeReplySettled = Promise.withResolvers<undefined>()
      installBundleRoute = async (route) => {
        const response = route.fetch().then(() => undefined, (error: unknown) => error)
        try {
          await loseActiveReply.promise
          await route.abort('failed')
          expect(await response).toBeUndefined()
        } finally {
          activeReplySettled.resolve(undefined)
        }
      }
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
      installBundleRoute = route => route.continue()
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
      // Freeze the real highlight's expiry timer and CSS first frame independently.
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
      const pausedHighlight = await page.addStyleTag({ content: '[data-plugin-highlight] { animation-play-state: paused !important; }' })
      try {
        await dialog.getByRole('button', { name: '立即启用', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        const card = panel.locator('[data-plugin-package="slow-package"][data-plugin-highlight]')
        await card.waitFor({ state: 'visible' })
        // `enableInstalled` marks the card and starts the directory reload the
        // Host answers, so the highlight is observable before the reload
        // commits the enabled bundle into the list. Measured 61 ms between the
        // two locally; this poll waits for that commit, which the single read
        // it replaces sampled inside.
        await expect.poll(
          () => card.getAttribute('data-plugin-status'),
          { timeout: 10_000 },
        ).toBe('running')
        expect(await panel.locator('[data-plugin-highlight]').count()).toBe(1)
        const styles = []
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(colorScheme === 'dark' ? '' : null)
          for (const reducedMotion of ['no-preference', 'reduce'] as const) {
            await page.emulateMedia({ reducedMotion })
            const style = await card.evaluate((element) => {
              const computed = getComputedStyle(element)
              return { boxShadow: computed.boxShadow, animationName: computed.animationName, animationDuration: computed.animationDuration }
            })
            expect(style.boxShadow).toMatch(/(?:\/|,)\s*0\.4\)/)
            expect(style.boxShadow).toContain('0px 0px 0px 2px')
            if (reducedMotion === 'reduce') {
              expect(style.animationName).toBe('none')
            } else {
              expect(style.animationName).toContain('dsh-plugin-highlight')
              expect(style.animationDuration).toBe('2.4s')
            }
            styles.push({ colorScheme, reducedMotion, boxShadow: style.boxShadow, animated: style.animationName !== 'none' })
          }
        }
        await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-cancel/highlight.expected.md', import.meta.url)),
          `${await captureStableAria(page, '[data-plugin-package="slow-package"]', scaffold.workspaceCwd)}\n\n${JSON.stringify(styles, null, 2)}`, webSnapshotMode())
        await page.clock.runFor(2400)
        await card.waitFor({ state: 'detached' })
      } finally {
        await pausedHighlight.evaluate((element) => { element.parentNode?.removeChild(element) })
        await page.emulateMedia({ colorScheme: null, reducedMotion: null })
        await page.clock.resume()
      }
      await panel.getByRole('button', { name: '添加插件', exact: true }).click()
      await dialog.getByRole('textbox').fill('recovered-package')
      installBundleRoute = async (route) => {
        await route.fetch()
        await route.abort('failed')
      }
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
