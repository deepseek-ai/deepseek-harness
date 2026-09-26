// Native initialization supplies system languages; the existing Host preference remains the only durable choice.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/desktop-locale', import.meta.url))
const MODE = webSnapshotMode()
const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
const versionCapture = { replacements: [[version, '{{version}}']] as const }

describe.skipIf(MODE === 'record')('web e2e: native and Client locale preferences', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const reported: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.exposeFunction('nativeLocaleRead', () => {
      const section = scaffold.ctx.settings.describe().find(row => row.ns === 'locale')!.value as { preference?: string }
      return { languages: ['ja-JP', 'zh-CN', 'en-US'], preference: section.preference ?? null }
    })
    await page.exposeFunction('nativeLocaleChanged', (locale: string) => { reported.push(locale) })
    await page.addInitScript(() => {
      const bridge = globalThis as typeof globalThis & {
        nativeLocaleRead(): Promise<unknown>
        nativeLocaleChanged(locale: string): Promise<void>
        __DSH_LOCALE__: { read(): Promise<unknown>; onChange(locale: string): void }
      }
      bridge.__DSH_LOCALE__ = {
        read: () => bridge.nativeLocaleRead(),
        onChange: (locale) => { void bridge.nativeLocaleChanged(locale) },
      }
    })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('uses OS languages without saving them, then shares an explicit choice across reloads', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-desktop-locale'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    const zhDialog = page.getByRole('dialog', { name: '设置', exact: true })
    await zhDialog.getByRole('button', { name: '中文', exact: true }).waitFor()
    await expect.poll(() => reported).toEqual(['zh'])
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'locale')!.value).toEqual({})
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'automatic.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, versionCapture), MODE)
    await zhDialog.getByRole('button', { name: '中文', exact: true }).click()
    await page.getByRole('menuitem', { name: 'English', exact: true }).click()
    const enDialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await enDialog.getByRole('button', { name: 'English', exact: true }).waitFor()
    await expect.poll(() => reported.at(-1)).toBe('en')
    await expect.poll(() => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'))
      .toContain('preference: en')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'selected.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, versionCapture), MODE)
    const warningsBefore = tripwire.warnings.length
    reported.length = 0
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await openSettings(page, 'en')
    await enDialog.getByRole('button', { name: 'English', exact: true }).waitFor()
    await expect.poll(() => reported).toEqual(['en'])
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
    expect(await page.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['automatic.expected.md', 'selected.expected.md'])
  })
})
