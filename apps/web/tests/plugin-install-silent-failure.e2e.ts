// A real Host/Remote/browser composition with a controllable package-manager process:
// pnpm fails without printing anything, and the dialog still shows what failed and where
// the complete log lives instead of a generic sentence over an empty details panel.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, captureStableAria, compareOrRefreshGolden, webSnapshotMode, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('reports a failed install whose pnpm printed nothing with its command line, output, and log file', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-install-silent-'))
  const overlay = join(scratch, 'cordis.patch.yml')
  await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`)
  let scaffold: WebScaffold | undefined
  try {
    scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
    const browser = await chromium.launch()
    try {
      const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
      // Node stands in for pnpm: `view` answers the check, and `add` exits unsuccessfully without printing
      // anything, the way a silent or early-crashing package manager leaves a failed run with no terminal output.
      await writeFile(join(profile, 'view'), 'console.log(JSON.stringify({ name: "silent-package", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }))\n')
      await writeFile(join(profile, 'add'), 'process.exitCode = 1\n')
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      if (await page.getByRole('dialog', { name: '设置' }).count() > 0) await page.keyboard.press('Escape')
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      await page.getByRole('button', { name: '添加插件', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox').fill('silent-package')
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      const failure = page.getByRole('dialog', { name: '插件安装失败', exact: true })
      await failure.waitFor({ timeout: 20_000 })
      // The sentence names the failed stage; the details carry the Host's own record of the run.
      await failure.getByText('安装命令失败，原因见安装详情', { exact: true }).waitFor()
      await failure.getByRole('button', { name: '查看安装详情', exact: true }).click()
      await failure.getByText('pnpm add silent-package', { exact: true }).waitFor()
      await failure.getByText(/Command failed with exit code 1:/).waitFor()
      expect(await failure.getByText(/^完整日志：.*pnpm\.log$/).count()).toBe(1)
      expect(await readFile(join(profile, 'package.json'), 'utf8')).not.toContain('silent-package')
      const snapshot = (await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd))
        .split(process.execPath).join('{{node}}')
        .split(scaffold.harnessHome).join('{{harnessHome}}')
        .replace(/operation-[A-Za-z0-9]+/g, 'operation-{{suffix}}')
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/plugin-install-silent-failure/failed.expected.md', import.meta.url)), snapshot, webSnapshotMode(),
      )
      expect(tripwire.pageErrors).toEqual([])
    } finally { await browser.close() }
  } finally {
    await scaffold?.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
