// A real Host/Remote/browser composition with a controllable package-manager process:
// the dialog offers the configured registries, the check asks them in turn while one
// is unreachable, and an install that loses its registry mid-run moves on to the next.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, captureStableAria, compareOrRefreshGolden, webSnapshotMode, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MIRROR = 'https://registry.npmmirror.com/'

it.each(['https://registry.npmjs.org/', MIRROR])('selects the fastest responding registry %s, remembers it, and falls back after a registry failure', async (winner) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-install-registry-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const requestLog = join(scratch, 'registry-pings.jsonl')
  await writeFile(requestLog, '')
  const overlay = join(scratch, 'cordis.patch.yml')
  const fixture = new URL('./fixtures/registry-ping.mjs', import.meta.url).href
  await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`
    + `- insert:\n    - id: registry-ping-fixture\n      name: ${JSON.stringify(fixture)}\n      config: ${JSON.stringify({ winner, requestLog })}\n`
    + `- id: ui-plugin-manager\n  config: ${JSON.stringify({ registryProbeEnabled: true })}\n`)
  let scaffold: WebScaffold | undefined
  try {
    scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
    const browser = await chromium.launch()
    try {
      const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
      const manifestPath = join(profile, 'package.json')
      // Node stands in for pnpm. `config` names npm's own registry as pnpm's own, so the mirror is a fallback for it.
      // `view` answers only when asked at the mirror: pnpm's own registry times out, the way an unreachable
      // registry.npmjs.org does, and pnpm prints the refusal as JSON on stdout. `add` fails its first run wherever
      // it is asked, naming the registry, and installs the package on the next; the Host moves it on to the next registry.
      await writeFile(join(profile, 'config'), 'console.log("https://registry.npmjs.org/")\n')
      await writeFile(join(profile, 'view'), `
        require('node:fs').appendFileSync('.registry-lookups', JSON.stringify(process.argv) + '\\n');
        if (!process.argv.includes('--registry=${MIRROR}')) {
          console.log(JSON.stringify({ error: { code: 'ERR_PNPM_META_FETCH_FAIL', message: 'GET https://registry.npmjs.org/mirrored-package: request timed out (ETIMEDOUT)' } }));
          process.exitCode = 1;
        } else {
          console.log(JSON.stringify({ name: 'mirrored-package', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
        }
      `)
      await writeFile(join(profile, 'add'), `
        import('node:fs').then(fs => {
        if (!fs.existsSync('.first-run')) {
          fs.writeFileSync('.first-run', '');
          fs.writeFileSync('pnpm-lock.yaml', 'partial lockfile');
          console.error('ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmmirror.com/mirrored-package: socket hang up');
          process.exitCode = 1;
          return;
        }
        fs.mkdirSync('node_modules/mirrored-package', { recursive: true });
        fs.writeFileSync('node_modules/mirrored-package/package.json', JSON.stringify({ name: 'mirrored-package', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
        fs.writeFileSync('node_modules/mirrored-package/cordis.patch.yml', '[]\\n');
        fs.writeFileSync('package.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('package.json', 'utf8')), dependencies: { 'mirrored-package': '2.0.0' } }));
        console.log('Installed from ' + (process.argv.find(arg => arg.startsWith('--registry=')) ?? 'the registry pnpm names'));
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
      const dialog = page.getByRole('dialog')
      // Folded, the registry control names pnpm's own registry; unfolded, its options float from it and offer the configured
      // mirror and a typed address.
      const registryToggle = dialog.getByRole('button', { name: winner === MIRROR ? '安装源 中国大陆镜像源' : '安装源 npm 官方源', exact: true })
      await registryToggle.waitFor()
      expect(await page.getByRole('radio').count()).toBe(0)
      await registryToggle.click()
      const options = page.getByRole('group', { name: '从哪个 npm 源下载插件', exact: true })
      const mirror = options.getByRole('radio', { name: '中国大陆镜像源（registry.npmmirror.com）', exact: true })
      await expect.poll(async () => (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean)).toHaveLength(2)
      const pingUrls = (await readFile(requestLog, 'utf8')).trim().split('\n').sort()
      expect(pingUrls).toEqual(['https://registry.npmjs.org/-/ping', 'https://registry.npmmirror.com/-/ping'].map(url => JSON.stringify(url)))
      if (winner === MIRROR) {
        expect(await mirror.isChecked()).toBe(true)
        await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-registry/fastest-default.expected.md', import.meta.url)),
          await captureStableAria(page, '[data-install-registry]', scaffold.workspaceCwd), webSnapshotMode())
      } else {
        expect(await options.getByRole('radio', { name: 'npm 官方源（registry.npmjs.org）', exact: true }).isChecked()).toBe(true)
        await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-registry/official-default.expected.md', import.meta.url)),
          await captureStableAria(page, '[data-install-registry]', scaffold.workspaceCwd), webSnapshotMode())
        await mirror.click()
      }
      expect(await options.getByRole('radio').count()).toBe(3)
      await dialog.getByRole('button', { name: '安装源 中国大陆镜像源', exact: true }).waitFor()
      await dialog.getByRole('textbox', { name: '包名或地址' }).fill('mirrored-package')
      const picker = (await captureStableAria(page, '[data-install-registry]', scaffold.workspaceCwd))
        .split(process.execPath).join('{{node}}')
        .split(scaffold.harnessHome).join('{{harnessHome}}')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-registry/picker.expected.md', import.meta.url)), picker, webSnapshotMode())
      // The options float over the dialog rather than inside it: the card keeps its height with them open, and Escape folds them.
      expect(await dialog.locator('[data-install-registry]').count()).toBe(0)
      await page.keyboard.press('Escape')
      await options.waitFor({ state: 'detached' })
      await dialog.getByRole('button', { name: '安装源 中国大陆镜像源', exact: true }).waitFor()
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      // The check asked the mirror first, which answered; the run that lost the mirror sent the install on to
      // the registry after it, which finished it. Each run shows behind the details with the registry it asked.
      await dialog.getByRole('button', { name: '立即启用', exact: true }).waitFor({ timeout: 20_000 })
      await dialog.getByText('版本 2.0.0', { exact: true }).waitFor()
      const lookups = (await readFile(join(profile, '.registry-lookups'), 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as string[])
      // The inspection asked the mirror first, and each install attempt checked the named package's
      // DSH peers at the registry that attempt would use: the mirror, then pnpm's own.
      expect(lookups.map(call => call.filter(argument => argument.startsWith('--registry=')))).toEqual([
        ['--registry=' + MIRROR], ['--registry=' + MIRROR], [],
      ])
      await dialog.getByRole('button', { name: '查看安装详情', exact: true }).click()
      await dialog.getByText('Installed from the registry pnpm names', { exact: true }).waitFor()
      await dialog.getByText('第 1 次 · 中国大陆镜像源', { exact: true }).waitFor()
      await dialog.getByText('第 2 次 · npm 官方源', { exact: true }).waitFor()
      expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({ dependencies: { 'mirrored-package': '2.0.0' } })
      const installed = (await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd))
        .split(process.execPath).join('{{node}}')
        .split(scaffold.harnessHome).join('{{harnessHome}}')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-registry/installed.expected.md', import.meta.url)), installed, webSnapshotMode())
      // The dialog opened again starts from the registry picked for the last install.
      await dialog.getByRole('button', { name: '立即启用', exact: true }).click()
      await panel.getByRole('button', { name: '添加插件', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: '安装源 中国大陆镜像源', exact: true }).waitFor()
      expect(tripwire.pageErrors).toEqual([])
    } finally { await browser.close() }
  } finally {
    await scaffold?.close()
  }
})
