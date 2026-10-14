// Web e2e scenario: the plugin lifecycle a user drives through the plugin manager, with real pnpm on local fixture
// packages and the live profile's HMR. The page installs, enables, disables, uninstalls, and reinstalls; upgrades go
// through the manager methods behind the agent's plugin_manager tool, removing and then installing. Every step checks which
// plugin version runs through the trace its apply and disposal append, and that a change HMR cannot apply asks for a
// restart or names its error.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangeResult } from '@deepseek-ai/dsh-plugin-manager'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const NAME = 'e2e-hmr-addon'

/** Real pnpm with its store, cache, and metadata under a test directory and no registry access. */
function isolatedPnpm(scratch: string) {
  return {
    command: 'pnpm', args: [],
    // pnpm 11 reads settings from pnpm_config_* variables.
    env: { pnpm_config_store_dir: join(scratch, 'pnpm-store'), pnpm_config_cache_dir: join(scratch, 'pnpm-cache'), pnpm_config_offline: 'true' },
  }
}

/** The page's toast or inline alert whose text contains the given words. */
function alertWith(page: Page, text: string): Locator {
  return page.getByRole('alert').filter({ hasText: text })
}

describe('web e2e: plugin lifecycle with HMR', () => {
  let scratch: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let tracePath: string

  /** Write one version of the fixture bundle, whose only row is its own plugin, into a directory of its own. */
  async function version(label: string, body = ''): Promise<string> {
    const dir = join(scratch, 'sources', label)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: NAME, version: `${label.replace(/\D/gu, '') || '0'}.0.0`, type: 'module', main: './index.mjs',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`)
    await writeFile(join(dir, 'index.mjs'), `${body}
import { appendFileSync } from 'node:fs'
export const name = '${NAME}'
export function apply(ctx) {
  appendFileSync(${JSON.stringify(tracePath)}, 'start:${label}\\n')
  ctx.effect(() => () => { appendFileSync(${JSON.stringify(tracePath)}, 'stop:${label}\\n') })
}
`)
    return dir
  }

  /** The trace lines since the last call, after the given ones have arrived. */
  async function traced(expected: string[]): Promise<void> {
    await expect.poll(async () => (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean), { timeout: 10_000 }).toEqual(expected)
    await writeFile(tracePath, '')
  }

  /** The running profile's manager, whose methods the agent's plugin_manager tool calls. */
  function manager() {
    return scaffold.ctx.get('pluginManager')!
  }

  /** Upgrade as the agent's tool does: an installed package is removed before another version is installed. */
  async function reinstall(spec: string): Promise<ChangeResult> {
    const removed = await manager().removeBundle(NAME)
    expect(removed.application, JSON.stringify(removed)).not.toBe('failed')
    return manager().installBundle(spec)
  }

  async function openPanel(): Promise<Locator> {
    if (await page.getByRole('dialog', { name: '设置' }).count() > 0) await page.keyboard.press('Escape')
    const panel = page.locator('[data-plugin-panel]')
    const list = panel.getByRole('heading', { name: '插件', exact: true })
    // The sidebar entry toggles the page, so it is pressed only while the page is closed.
    if (await panel.count() === 0) {
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    } else if (!await list.isVisible()) {
      await panel.getByRole('button', { name: '返回插件', exact: true }).click()
    }
    await list.waitFor({ timeout: 10_000 })
    return panel
  }

  /** Install a spec through the page's dialog and switch the bundle on from its finished screen. */
  async function installThroughPage(spec: string): Promise<Locator> {
    const panel = await openPanel()
    await panel.getByRole('button', { name: '添加插件', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '包名或地址' }).fill(spec)
    await dialog.getByRole('button', { name: '安装', exact: true }).click()
    await dialog.getByRole('button', { name: '立即启用', exact: true }).click({ timeout: 30_000 })
    await dialog.waitFor({ state: 'detached', timeout: 10_000 })
    return panel
  }

  async function uninstallThroughPage(panel: Locator): Promise<void> {
    await panel.getByRole('button', { name: `查看 ${NAME}`, exact: true }).click()
    await panel.getByRole('button', { name: `卸载 ${NAME}`, exact: true }).click()
    await page.getByRole('dialog', { name: `卸载「${NAME}」？` }).getByRole('button', { name: '卸载', exact: true }).click()
    // The page leaves the removed package's details for the list.
    await panel.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 30_000 })
    await expect.poll(() => panel.locator(`[data-plugin-package="${NAME}"]`).count(), { timeout: 30_000 }).toBe(0)
  }

  async function dependency(): Promise<string | undefined> {
    const manifest = JSON.parse(await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return manifest.dependencies?.[NAME]
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-plugin-hmr-'))
    tracePath = join(scratch, 'trace.log')
    await writeFile(tracePath, '')
    scaffold = await launchWebScaffold({ profile: { packages: [], packageManager: isolatedPnpm(scratch) } })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.waitForSelector('[class*="frame"]')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(scratch, { recursive: true, force: true })
  })

  it('installs, switches off and on, and upgrades without a restart', async () => {
    const v1 = await version('v1')
    const panel = await installThroughPage(`file:${v1}`)
    await traced(['start:v1'])
    const toggle = panel.getByRole('switch', { name: `启用 ${NAME}`, exact: true })
    await toggle.click()
    await traced(['stop:v1'])
    await toggle.click()
    await traced(['start:v1'])
    // Installing over the installed package is refused; the upgrade removes it first.
    const v2 = await version('v2')
    expect(await manager().installBundle(`file:${v2}`)).toMatchObject({ application: 'failed', error: { code: 'already-installed' } })
    const upgraded = await reinstall(`file:${v2}`)
    expect(upgraded, JSON.stringify(upgraded)).toMatchObject({ application: 'applied' })
    await traced(['stop:v1', 'start:v2'])
    // The page reads the upgrade from the Host's change announcement.
    await panel.getByRole('button', { name: `查看 ${NAME}`, exact: true }).click()
    await panel.getByText('v2.0.0', { exact: true }).waitFor({ timeout: 10_000 })
    await panel.getByRole('button', { name: '返回插件' }).click()
  }, 90_000)

  it('stops the running version and names the load error when the upgrade cannot load, then applies the fix', async () => {
    const broken = await version('v3', "import 'e2e-hmr-missing-dependency'\n")
    const failed = await reinstall(`file:${broken}`)
    expect(failed).toMatchObject({ application: 'failed', error: { code: 'operation-error' } })
    expect(failed.error?.diagnostic).toContain('e2e-hmr-missing-dependency')
    await traced(['stop:v2'])
    // Switching the broken plugin off and on again loads the same files, and the page names the missing dependency.
    const panel = await openPanel()
    const toggle = panel.getByRole('switch', { name: `启用 ${NAME}`, exact: true })
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
    await toggle.click()
    await alertWith(page, 'e2e-hmr-missing-dependency').waitFor({ timeout: 10_000 })
    expect(await alertWith(page, 'e2e-hmr-missing-dependency').textContent()).not.toContain('重启')
    await traced([])
    const fixed = await version('v4')
    expect(await reinstall(`file:${fixed}`)).toMatchObject({ application: 'applied' })
    await traced(['start:v4'])
  }, 90_000)

  it('reports an upgrade that loads but cannot start, then recovers with a working version', async () => {
    const throwing = await version('v5')
    await writeFile(join(throwing, 'index.mjs'), `export const name = '${NAME}'\nexport function apply() { throw new Error('v5 cannot start') }\n`)
    const failed = await reinstall(`file:${throwing}`)
    expect(failed).toMatchObject({ application: 'failed', error: { code: 'operation-error' } })
    expect(failed.error?.diagnostic).toContain('v5 cannot start')
    await traced(['stop:v4'])
    const working = await version('v6')
    expect(await reinstall(`file:${working}`)).toMatchObject({ application: 'applied' })
    await traced(['start:v6'])
  }, 90_000)

  it('uninstalls and reinstalls the same package with its new code', async () => {
    const panel = await openPanel()
    await uninstallThroughPage(panel)
    await traced(['stop:v6'])
    // pnpm removes the package after its plugins stop.
    await expect.poll(dependency, { timeout: 30_000 }).toBeUndefined()
    const v7 = await version('v7')
    await installThroughPage(`file:${v7}`)
    await traced(['start:v7'])
    await uninstallThroughPage(await openPanel())
    await traced(['stop:v7'])
    await expect.poll(dependency, { timeout: 30_000 }).toBeUndefined()
  }, 90_000)

  it('starts a plugin linked to another directory without a restart', async () => {
    // A bare local path links the package to its directory, as for a plugin under development.
    const first = await version('v8')
    await installThroughPage(first)
    await traced(['start:v8'])
    expect(await dependency()).toMatch(/^link:/u)
    const moved = await version('v9')
    expect(await reinstall(moved)).toMatchObject({ application: 'applied' })
    await traced(['stop:v8', 'start:v9'])
    expect(await alertWith(page, '重启').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})

describe('web e2e: plugin installation without HMR', () => {
  it('asks for a restart after installing into a profile that applies changes at startup', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-plugin-startup-'))
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    try {
      const dir = join(scratch, 'addon')
      await mkdir(dir)
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: NAME, version: '1.0.0', type: 'module', main: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      await writeFile(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`)
      await writeFile(join(dir, 'index.mjs'), `export const name = '${NAME}'\nexport function apply() {}\n`)
      scaffold = await launchWebScaffold({ profile: { packages: [], hmr: false, packageManager: isolatedPnpm(scratch) } })
      browser = await chromium.launch()
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      if (await page.getByRole('dialog', { name: '设置' }).count() > 0) await page.keyboard.press('Escape')
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.getByRole('button', { name: '添加插件', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox', { name: '包名或地址' }).fill(`file:${dir}`)
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      await dialog.getByText('已安装，请重启 DSH 加载它。这个 profile 只在启动时应用更改。', { exact: true }).waitFor({ timeout: 30_000 })
    } finally {
      await browser?.close()
      await scaffold?.close()
      await rm(scratch, { recursive: true, force: true })
    }
  }, 120_000)
})
